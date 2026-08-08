import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  type GuildMember,
} from "discord.js";

import { db } from "@guildthing/db";

const QUESTION_TIMEOUT_MS = 5 * 60_000;
const MAX_NICKNAME_LENGTH = 32;

interface MatchedCharacter {
  rank: string;
  level: number;
  class: string | null;
}

interface RoleCondition {
  field: string;
  textValue: string | null;
  minNumber: number | null;
  maxNumber: number | null;
}

function splitAltNames(raw: string): string[] {
  return raw
    .split(/[,/\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Cuts at the last "/" boundary that still fits under Discord's 32-char
// nickname cap, rather than chopping a name in half.
function truncateNickname(fullName: string): string {
  if (fullName.length <= MAX_NICKNAME_LENGTH) return fullName;
  const cut = fullName.slice(0, MAX_NICKNAME_LENGTH);
  const lastBoundary = cut.lastIndexOf("/");
  return lastBoundary > 0 ? cut.slice(0, lastBoundary) : cut;
}

async function askText(
  member: GuildMember,
  question: string,
): Promise<string | null> {
  const dm = await member.createDM();
  await dm.send(question);
  try {
    const collected = await dm.awaitMessages({
      filter: (m) => m.author.id === member.id,
      max: 1,
      time: QUESTION_TIMEOUT_MS,
      errors: ["time"],
    });
    return collected.first()?.content.trim() ?? null;
  } catch {
    console.log(`[bot] ${member.user.tag} didn't answer in time, stopping onboarding`);
    return null;
  }
}

// Generic button-choice question — used for guild/PUG and the
// include-alts-in-nickname question. Returns the clicked button's
// customId, or null on timeout.
async function askChoice(
  member: GuildMember,
  content: string,
  choices: { id: string; label: string; primary?: boolean }[],
): Promise<string | null> {
  const dm = await member.createDM();
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    choices.map((c) =>
      new ButtonBuilder()
        .setCustomId(c.id)
        .setLabel(c.label)
        .setStyle(c.primary ? ButtonStyle.Primary : ButtonStyle.Secondary),
    ),
  );
  const message = await dm.send({ content, components: [row] });
  try {
    const interaction = await message.awaitMessageComponent({
      componentType: ComponentType.Button,
      time: QUESTION_TIMEOUT_MS,
    });
    await interaction.update({ components: [] });
    return interaction.customId;
  } catch {
    console.log(`[bot] ${member.user.tag} didn't answer in time, stopping onboarding`);
    return null;
  }
}

// field/operator meanings match GuildRoleRuleCondition (schema.prisma):
// rank/class use "equals" against textValue, level uses "between" against
// minNumber/maxNumber. operator itself isn't checked here since field alone
// determines how a condition is evaluated.
function conditionMatches(
  character: MatchedCharacter,
  condition: RoleCondition,
): boolean {
  if (condition.field === "rank") {
    return character.rank.toLowerCase() === condition.textValue?.toLowerCase();
  }
  if (condition.field === "class") {
    return (
      condition.textValue != null &&
      character.class?.toLowerCase() === condition.textValue.toLowerCase()
    );
  }
  if (condition.field === "level") {
    return (
      condition.minNumber != null &&
      condition.maxNumber != null &&
      character.level >= condition.minNumber &&
      character.level <= condition.maxNumber
    );
  }
  return false;
}

async function applyNicknameAndRoles(
  member: GuildMember,
  names: string[],
  roleIds: string[],
): Promise<void> {
  const fullName = names.join("/");
  const nickname = truncateNickname(fullName);
  try {
    await member.setNickname(nickname);
    if (nickname !== fullName) {
      // Discord's 32-char nickname cap cut off some of the names (mainly
      // hits people with several alts) — say so rather than silently
      // dropping names off the end.
      await member.send(
        `Heads up — your full name list (\`${fullName}\`) didn't fit Discord's 32-character nickname limit, so I set it to \`${nickname}\`. Ask an officer if you'd like a different combination shown instead.`,
      );
    }
  } catch (err) {
    console.error(`[bot] failed to set nickname for ${member.user.tag}:`, err);
  }
  if (roleIds.length > 0) {
    try {
      await member.roles.add(roleIds);
    } catch (err) {
      console.error(`[bot] failed to add roles for ${member.user.tag}:`, err);
    }
  }
}

export async function handleNewMember(member: GuildMember): Promise<void> {
  const guild = await db.guild.findUnique({
    where: { discordGuildId: member.guild.id },
  });
  if (!guild) {
    // This Discord server isn't registered as a GuildThing guild — nothing
    // for the bot to do here.
    return;
  }

  const mainName = await askText(member, "Welcome! What's your in-game nickname?");
  if (mainName == null) return;

  const affiliation = await askChoice(
    member,
    "Are you a guild member, or are you here to join a PUG?",
    [
      { id: "guild", label: "Guild member", primary: true },
      { id: "pug", label: "PUG" },
    ],
  );
  if (affiliation == null) return;

  if (affiliation === "pug") {
    await applyNicknameAndRoles(
      member,
      [mainName],
      guild.pugRoleId ? [guild.pugRoleId] : [],
    );
    return;
  }

  const altsRaw = await askText(
    member,
    "Do you have any alts? What are their names? (separate multiple names with commas)",
  );
  const altNames = altsRaw ? splitAltNames(altsRaw) : [];
  const allNames = [mainName, ...altNames];

  // Only worth asking if there's actually a choice to make — someone with
  // no alts just gets their main name, no extra question.
  let includeAltsInNickname = true;
  if (altNames.length > 0) {
    const choice = await askChoice(
      member,
      `Do you want your alts included in your server nickname? e.g. "${allNames.join("/")}"`,
      [
        { id: "yes", label: "Yes", primary: true },
        { id: "no", label: "No" },
      ],
    );
    if (choice == null) return;
    includeAltsInNickname = choice === "yes";
  }

  const rosterRows = await db.guildRosterMember.findMany({
    where: { guildId: guild.id },
  });
  const rosterByName = new Map(rosterRows.map((r) => [r.name.toLowerCase(), r]));

  const matched: MatchedCharacter[] = [];
  const displayNames: string[] = [];
  for (const name of allNames) {
    const row = rosterByName.get(name.toLowerCase());
    if (row) {
      matched.push({ rank: row.rank, level: row.level, class: row.class });
      displayNames.push(row.name);
    } else {
      displayNames.push(name);
    }
  }

  const roleIds = new Set<string>();
  if (matched.length > 0) {
    const rules = await db.guildRoleRule.findMany({
      where: { guildId: guild.id },
      include: { conditions: true },
    });
    for (const rule of rules) {
      const fires = rule.conditions.every((condition) =>
        matched.some((character) => conditionMatches(character, condition)),
      );
      if (fires) roleIds.add(rule.discordRoleId);
    }
  }

  const nicknameNames = includeAltsInNickname ? displayNames : displayNames.slice(0, 1);
  await applyNicknameAndRoles(member, nicknameNames, [...roleIds]);
}
