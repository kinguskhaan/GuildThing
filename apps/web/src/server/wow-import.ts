import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { db as Db } from "~/server/db";

// Matches the JSON GuildThing Roster's /gtr export produces (Core.lua's
// GT.ExportRoster) — plain JSON, not the base64+zlib pipeline the older
// recipe export uses, since a roster scan is small enough not to need it.
export const rosterExportSchema = z.object({
  guild: z.string().optional(),
  exportedAt: z.number().optional(),
  members: z
    .array(
      z.object({
        name: z.string().min(1),
        rank: z.string(),
        level: z.number(),
        class: z.string().nullable().optional(),
        note: z.string().nullable().optional(),
        officernote: z.string().nullable().optional(),
      }),
    )
    // Sanity cap for the /api/v1/roster endpoint — an unauthenticated-by-
    // session, key-only route shouldn't accept an unbounded body.
    .max(2000),
});
export type RosterExport = z.infer<typeof rosterExportSchema>;

export const professionsExportSchema = z.record(
  z.string(),
  z.array(
    z.object({
      name: z.string(),
      itemID: z.number().nullable(),
      spellID: z.number().nullable().optional(),
    }),
  ),
);

// peers: everyone the exporting character picked up via OurRecipes' P2P
// mesh (GuildThingDB.P2PData), shaped exactly like the top-level character
// — see GT.ExportCurrentCharacter in that addon's Core.lua. Each is a
// second-hand copy of someone else's recipes, not a self-report, so
// applyCharacterImport below stores them as unclaimed rows rather than
// owned by whoever happened to submit this export.
export const wowImportSchema = z.object({
  name: z.string().min(1),
  realm: z.string().min(1),
  class: z.string().min(1).optional(),
  professions: professionsExportSchema,
  peers: z
    .array(
      z.object({
        name: z.string().min(1),
        realm: z.string().min(1),
        class: z.string().min(1).optional(),
        professions: professionsExportSchema,
      }),
    )
    .optional(),
});
export type WowImportCharacter = z.infer<typeof wowImportSchema>;

// A GuildThing Roster addon scan is a complete point-in-time snapshot of
// everyone in the guild, so rows for people who've since left still get
// deleted on the next import — but existing rows are upserted by name, not
// deleted and recreated, so claimedByDiscordUserId/Tag (set during Discord
// onboarding) survives a re-import instead of being wiped every time.
//
// `actorUserId` is only ever used to stamp who/what imported this —
// `Guild.lastRosterImportedById` is nullable, so `null` (an API-key-driven
// import via apps/sync, see /api/v1/roster) is a normal value here, not a
// special case.
export async function applyRosterImport(
  db: typeof Db,
  guildId: string,
  actorUserId: string | null,
  parsed: RosterExport,
) {
  const { members, guild: inGameGuildName } = parsed;
  const importedNames = members.map((m) => m.name);

  // Read current ranks up front so each upsert below can tell whether its
  // incoming rank actually differs from what's stored — needed to stamp
  // rankChangedAt only on a real transition, not on every import (most
  // imports re-send the same rank for most members). A brand-new name
  // (not in this map) gets no rankChangedAt yet — there's no prior rank
  // for it to have "changed" from.
  const existingRanks = new Map(
    (
      await db.guildRosterMember.findMany({
        where: { guildId, name: { in: importedNames } },
        select: { name: true, rank: true },
      })
    ).map((r) => [r.name, r.rank]),
  );
  const now = new Date();
  // The in-game half of the unified audit log — one row per actual rank
  // transition detected below, merged chronologically with
  // GuildRoleChangeEvent (the Discord half) for display. See
  // GuildRankChangeEvent in schema.prisma for why it's keyed by name
  // instead of FK'd to the roster row.
  const rankChangeEvents: { characterName: string; oldRank: string; newRank: string }[] = [];

  await db.$transaction([
    db.guildRosterMember.deleteMany({
      where: {
        guildId,
        name: { notIn: importedNames },
        manuallyAdded: false,
      },
    }),
    ...members.map((m) => {
      const priorRank = existingRanks.get(m.name);
      const rankChanged = priorRank !== undefined && priorRank !== m.rank;
      if (rankChanged) {
        rankChangeEvents.push({ characterName: m.name, oldRank: priorRank, newRank: m.rank });
      }
      return db.guildRosterMember.upsert({
        where: { guildId_name: { guildId, name: m.name } },
        create: {
          guildId,
          name: m.name,
          rank: m.rank,
          level: m.level,
          class: m.class ?? null,
          note: m.note ?? null,
          officerNote: m.officernote ?? null,
        },
        update: {
          rank: m.rank,
          level: m.level,
          class: m.class ?? null,
          note: m.note ?? null,
          officerNote: m.officernote ?? null,
          ...(rankChanged ? { rankChangedAt: now } : {}),
        },
      });
    }),
    ...rankChangeEvents.map((e) =>
      db.guildRankChangeEvent.create({
        data: {
          guildId,
          characterName: e.characterName,
          oldRank: e.oldRank,
          newRank: e.newRank,
          detectedAt: now,
        },
      }),
    ),
    db.guild.update({
      where: { id: guildId },
      data: {
        lastRosterImportedAt: new Date(),
        lastRosterImportedById: actorUserId,
        // The addon already knows the in-game guild's name at scan time —
        // no reason to also make an admin type it into the armory-lookup
        // config by hand. Only overwrites when the export actually carries
        // one, so an armory config set before any roster import is ever
        // done isn't clobbered with an empty value.
        ...(inGameGuildName ? { wowGuildName: inGameGuildName } : {}),
      },
    }),
  ]);

  return { count: members.length };
}

// Writes one character's own professions, plus any peer characters it
// picked up over OurRecipes' P2P mesh.
//
// `actorUserId` is a real session user for a self-import (paste-in-browser
// or the onboarding DM flow) and `null` for an API-key-driven push (see
// /api/v1/characters) — both are the character's own authoritative scan,
// so both fully replace its professions. The only difference is ownership:
// a self-import claims/reclaims the row; an API-key push never stamps
// `userId` at all, so it can neither claim an unclaimed row nor un-claim
// one a real member already claimed through onboarding. Peers are always
// merge-only and unclaimed, regardless of `actorUserId` — see the loop
// below.
export async function applyCharacterImport(
  db: typeof Db,
  guildId: string,
  actorUserId: string | null,
  character: WowImportCharacter,
) {
  const { name, realm, class: charClass, professions, peers } = character;

  return db.$transaction(async (tx) => {
    // Guard against hijack: sharing guildId+name+realm as the identity key
    // (instead of guildId+userId+name+realm) means an import can land on a
    // row someone ELSE already claimed. A real character name is unique
    // per realm, so this should only happen from a mistaken or malicious
    // paste — never silently steal ownership. Only applies when a real
    // user is asserting identity; an API-key push (actorUserId === null)
    // never claims anything, so it can't hijack.
    const existing = await tx.guildCharacter.findUnique({
      where: { guildId_name_realm: { guildId, name, realm } },
    });
    if (actorUserId && existing?.userId && existing.userId !== actorUserId) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `${name}-${realm} is already claimed by another member of this guild.`,
      });
    }

    const characterRow = await tx.guildCharacter.upsert({
      where: { guildId_name_realm: { guildId, name, realm } },
      create: {
        guildId,
        userId: actorUserId,
        name,
        realm,
        class: charClass,
      },
      update: actorUserId
        ? { userId: actorUserId, class: charClass }
        : { class: charClass },
    });

    await tx.profession.deleteMany({
      where: { characterId: characterRow.id },
    });

    for (const [professionName, recipes] of Object.entries(professions)) {
      await tx.profession.create({
        data: {
          characterId: characterRow.id,
          name: professionName,
          recipes: {
            create: recipes.map((r) => ({
              name: r.name,
              itemId: r.itemID,
              spellId: r.spellID ?? null,
            })),
          },
        },
      });
    }

    // Peers are second-hand data (relayed through OurRecipes' P2P mesh,
    // not self-reported) — merge-only, same "recipes only ever gained"
    // rule the addon's own P2P sync follows. Never deletes a
    // profession/recipe, never overwrites class on an already-known
    // character, and never touches userId — an unclaimed row stays
    // unclaimed until its real player self-imports it (above), and a
    // claimed row's ownership is never taken over by someone else's peer
    // cache.
    for (const peer of peers ?? []) {
      if (peer.name === name && peer.realm === realm) continue; // self-echo guard

      const peerCharacter = await tx.guildCharacter.upsert({
        where: {
          guildId_name_realm: { guildId, name: peer.name, realm: peer.realm },
        },
        create: {
          guildId,
          userId: null,
          name: peer.name,
          realm: peer.realm,
          class: peer.class,
        },
        update: {},
      });

      for (const [professionName, recipes] of Object.entries(
        peer.professions,
      )) {
        const profession = await tx.profession.upsert({
          where: {
            characterId_name: {
              characterId: peerCharacter.id,
              name: professionName,
            },
          },
          create: { characterId: peerCharacter.id, name: professionName },
          update: {},
        });

        const existingNames = new Set(
          (
            await tx.recipe.findMany({
              where: { professionId: profession.id },
              select: { name: true },
            })
          ).map((r) => r.name),
        );
        const newRecipes = recipes.filter((r) => !existingNames.has(r.name));
        if (newRecipes.length > 0) {
          await tx.recipe.createMany({
            data: newRecipes.map((r) => ({
              professionId: profession.id,
              name: r.name,
              itemId: r.itemID,
              spellId: r.spellID ?? null,
            })),
          });
        }
      }
    }

    return characterRow;
  });
}
