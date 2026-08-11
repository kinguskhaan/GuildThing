import {
  ActionRowBuilder,
  type AnyThreadChannel,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  ChannelType,
  type ChatInputCommandInteraction,
  type Client,
  EmbedBuilder,
  type ForumChannel,
  type Message,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  StringSelectMenuBuilder,
  type StringSelectMenuInteraction,
  type TextChannel,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

import { db } from "@guildthing/db";

import { classEmojiTag } from "./classIcons.js";

const MODAL_TIMEOUT_MS = 5 * 60_000;

// How long the thread sits idle before Discord auto-archives it (it isn't
// deleted by archiving, just hidden — only an explicit cancel deletes it).
const THREAD_AUTO_ARCHIVE_MINUTES = 1440;

const eventInclude = {
  timeOptions: { include: { votes: true } },
  roleSlots: { include: { signups: true } },
} as const;

interface EventWithRelations {
  id: string;
  guildId: string;
  title: string;
  imageUrl: string | null;
  date: string | null;
  description: string | null;
  createdByDiscordUserId: string;
  createdByDiscordTag: string;
  discordChannelId: string;
  discordThreadId: string | null;
  discordMessageId: string | null;
  status: string;
  lockedTimeOptionId: string | null;
  createdAt: Date;
  timeOptions: {
    id: string;
    label: string;
    votes: { discordUserId: string }[];
  }[];
  roleSlots: {
    id: string;
    roleName: string;
    capacity: number;
    emoji: string | null;
    signups: {
      discordUserId: string;
      characterName: string | null;
      class: string | null;
      isLeader: boolean;
    }[];
  }[];
}

// "Name:Count:Emoji, Name:Count" → role slots — the emoji segment is
// optional (a bare unicode emoji, or a custom server emoji pasted in its
// <:name:id>/<a:name:id> form, which is what Discord's own emoji picker
// inserts when used inside a modal text field). Silently skips malformed
// segments rather than rejecting the whole thing — best effort, same
// spirit as the alt-name splitting in onboarding.ts.
// Custom emoji (<:name:id>) contains colons itself, so this can't just
// split(":") — the emoji segment, if present, is everything after the
// second colon, not a third colon-delimited token.
const ROLE_SLOT_PATTERN = /^\s*([^:]+):(\d+)(?::(.+))?\s*$/;

function parseRoleSlots(
  input: string,
): { roleName: string; capacity: number; emoji: string | null }[] {
  const slots: { roleName: string; capacity: number; emoji: string | null }[] =
    [];
  for (const segment of input.split(",")) {
    const match = ROLE_SLOT_PATTERN.exec(segment);
    if (!match) continue;
    const roleName = match[1]!.trim();
    const capacity = Number(match[2]);
    const emoji = match[3]?.trim() || null;
    if (roleName && Number.isInteger(capacity) && capacity > 0) {
      slots.push({ roleName, capacity, emoji });
    }
  }
  return slots;
}

function parseTimeOptions(input: string | null): string[] {
  if (!input) return [];
  return input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function todayISODate(): string {
  return new Date().toISOString().slice(0, 10);
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Falls back to today rather than accepting garbage — same "best effort,
// don't reject the whole thing" spirit as parseRoleSlots, but a date field
// is meant to default to today anyway, so an unparsable value might as
// well just become that instead of null.
function parseEventDate(input: string): string {
  const trimmed = input.trim();
  return ISO_DATE_PATTERN.test(trimmed) ? trimmed : todayISODate();
}

// Embed text renders a raw <:name:id>/<a:name:id> tag as the actual custom
// emoji on its own, but a select-menu option's `emoji` field needs it
// pre-parsed into {id, name, animated} instead — this is only used there.
function toSelectEmoji(
  raw: string | null,
): string | { id: string; name: string; animated: boolean } | undefined {
  if (!raw) return undefined;
  const match = /^<(a)?:(\w+):(\d+)>$/.exec(raw);
  if (!match) return raw;
  return { animated: !!match[1], name: match[2]!, id: match[3]! };
}

function voteBar(count: number, maxCount: number): string {
  if (maxCount === 0) return "░".repeat(10);
  const filled = Math.round((count / maxCount) * 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

// One single embed — a message with multiple embeds always renders each as
// its own separately-bordered card with a visible gap between them, no
// matter how well the colors match, so splitting the image out into its
// own embed (an earlier version of this) never actually looked
// "connected" the way it was meant to. Within one embed the image always
// renders below the fields (fixed Discord ordering, no way around it), so
// that's where it lands here — the trade-off for one genuinely seamless
// card instead of two stacked ones.
function buildEventEmbeds(event: EventWithRelations): EmbedBuilder[] {
  const color =
    event.status === "cancelled"
      ? 0x99_1e_1e
      : event.status === "locked"
        ? 0x2e_7d_32
        : 0x5865_f2;

  const totalCapacity = event.roleSlots.reduce((sum, s) => sum + s.capacity, 0);
  const totalSignups = event.roleSlots.reduce(
    (sum, s) => sum + s.signups.length,
    0,
  );
  const maxVotes = Math.max(0, ...event.timeOptions.map((t) => t.votes.length));

  // A zero-width-space field with no name/value renders as a blank row —
  // the standard trick for a breathing-room gap between embed sections,
  // since Discord otherwise packs fields tightly together.
  const spacer = { name: "\u200B", value: "\u200B", inline: false };

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(event.title)
    .setDescription(event.description)
    .addFields(
      { name: "📅 Date", value: event.date ?? "—", inline: true },
      {
        name: "👥 Signed up",
        value: `${totalSignups}/${totalCapacity}`,
        inline: true,
      },
    );

  if (event.status === "locked") {
    embed.addFields({
      name: "🔒 Locked in",
      value:
        event.timeOptions.find((t) => t.id === event.lockedTimeOptionId)
          ?.label ?? "TBD",
      inline: true,
    });
  } else if (event.status === "cancelled") {
    embed.addFields({ name: "Status", value: "❌ Cancelled", inline: true });
  }

  if (event.timeOptions.length > 0) {
    embed.addFields(spacer, {
      name: "Proposed times (vote for what works for you)",
      value: event.timeOptions
        .map(
          (t) =>
            `**${t.label}** — ${t.votes.length} vote${t.votes.length === 1 ? "" : "s"}\n${voteBar(t.votes.length, maxVotes)}`,
        )
        .join("\n\n"),
    });
  }

  embed.addFields(spacer);

  for (const slot of event.roleSlots) {
    const lines = slot.signups.length
      ? slot.signups
          .map((s, i) => {
            const classIcon = classEmojiTag(s.class);
            const classSuffix = classIcon
              ? ` ${classIcon}`
              : s.class
                ? ` (${s.class})`
                : "";
            // Character name is the primary label — only fall back to the
            // Discord mention when nobody's claimed a character (nothing
            // else to show), instead of always showing both.
            const displayName = s.characterName ?? `<@${s.discordUserId}>`;
            return `\`${i + 1}\` ${s.isLeader ? "👑 " : ""}${displayName}${classSuffix}`;
          })
          .join("\n")
      : "_empty_";
    embed.addFields({
      name: `${slot.emoji ? `${slot.emoji} ` : ""}${slot.roleName} (${slot.signups.length}/${slot.capacity})`,
      value: lines,
      inline: false,
    });
  }

  if (event.status === "open") {
    embed.setFooter({
      text: "We'll lock in the time once everyone has voted.",
    });
  }

  // Discord's embed image only accepts http(s)/attachment URLs — the web
  // form validates this too, but guard here as well since a bad value
  // shouldn't be able to break every future sync of this event's message.
  // setImage (not setThumbnail) so a pasted GIF actually animates at full
  // size instead of sitting tiny in the corner — it renders below all the
  // fields above, which is the trade-off for one seamless embed instead of
  // two stacked ones (see the comment on this function).
  if (event.imageUrl && /^https?:\/\//.test(event.imageUrl)) {
    embed.setImage(event.imageUrl);
  }

  return [embed];
}

function buildEventComponents(event: EventWithRelations) {
  // Cancelled events get their post deleted outright (see syncEventMessage)
  // so this never actually renders for one, but stay defensive anyway.
  if (event.status === "cancelled") return [];

  // "Locked" only means the TIME is decided — it shouldn't also freeze who's
  // doing what. Someone realizing they picked the wrong role (or wanting to
  // drop out) after lock is exactly the "no way to change my sign-up"
  // complaint this fixes, so role-switching and leaving stay available;
  // only the time-voting components go away once it's settled.
  const isOpen = event.status === "open";

  const rows: (
    ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>
  )[] = [];

  const openSlots = event.roleSlots.filter(
    (s) => s.signups.length < s.capacity,
  );
  if (openSlots.length > 0) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`event:${event.id}:role`)
          .setPlaceholder("Sign up for a role...")
          .addOptions(
            openSlots.map((s) => ({
              label: `${s.roleName} (${s.signups.length}/${s.capacity} taken)`,
              value: s.id,
              emoji: toSelectEmoji(s.emoji),
            })),
          ),
      ),
    );
  }

  // Role slots are otherwise fixed at creation — this is what lets the
  // creator add one they forgot, or remove one, without the Edit modal
  // (which only covers title/image/date; roles have existing signups tied
  // to them, same reasoning as time options having their own add/remove
  // instead of being free-text editable). Stays available after lock, same
  // as the role-signup select above.
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`event:${event.id}:addrole`)
        .setLabel("+ Add role")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`event:${event.id}:removerole`)
        .setLabel("Remove a role")
        .setStyle(ButtonStyle.Secondary),
    ),
  );

  if (isOpen && event.timeOptions.length > 0) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`event:${event.id}:vote`)
          .setPlaceholder("Vote for a time...")
          .addOptions(
            event.timeOptions.map((t) => ({ label: t.label, value: t.id })),
          ),
      ),
    );
    // No automatic timer decides when voting's "done" — the creator locks
    // it in manually once they judge everyone's voted. Picking a mistaken
    // time (e.g. a typo) also has no direct "edit" — remove it and add the
    // corrected one instead. Both gated to the creator (same as Edit/
    // Cancel) via an ephemeral picker for removal, so a wrong click can't
    // nuke someone's proposal or lock things in early.
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`event:${event.id}:lockin`)
          .setLabel("Lock in the time")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`event:${event.id}:removetime`)
          .setLabel("Remove a time option")
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  }

  const actionButtons = [
    new ButtonBuilder()
      .setCustomId(`event:${event.id}:leave`)
      .setLabel("Leave")
      .setStyle(ButtonStyle.Secondary),
    // Visible to everyone (Discord has no per-viewer component
    // visibility) but only usable by the creator — same permission check
    // as Cancel group, enforced in handleEventComponentInteraction.
    new ButtonBuilder()
      .setCustomId(`event:${event.id}:edit`)
      .setLabel("Edit")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`event:${event.id}:cancel`)
      .setLabel("Cancel group")
      .setStyle(ButtonStyle.Danger),
  ];
  if (isOpen) {
    actionButtons.unshift(
      new ButtonBuilder()
        .setCustomId(`event:${event.id}:addtime`)
        .setLabel("+ Add time option")
        .setStyle(ButtonStyle.Secondary),
    );
  }
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(actionButtons));

  return rows;
}

async function fetchEventWithRelations(
  eventId: string,
): Promise<EventWithRelations | null> {
  return db.event.findUnique({ where: { id: eventId }, include: eventInclude });
}

async function renderToInteraction(
  interaction: StringSelectMenuInteraction | ButtonInteraction,
  event: EventWithRelations,
): Promise<void> {
  await interaction.update({
    embeds: buildEventEmbeds(event),
    components: buildEventComponents(event),
  });
}

// Posts the event embed where people can actually see it, plus a thread for
// follow-up discussion — the two live in different places depending on
// channel type:
// - Forum channel: the post itself IS the thread (Discord requires every
//   forum post to have one), so the embed lands as that thread's starter
//   message. Forum posts already show up as prominent cards, so there's
//   nothing more to do for visibility.
// - Plain text channel: the embed is a normal, fully-visible channel
//   message (sign-up/vote components included) — NOT hidden inside a
//   thread, since a bare thread with no parent message barely shows up in
//   a busy channel and is easy to miss entirely. A thread is then attached
//   to that message (message.startThread()) purely for discussion; signing
//   up still happens on the visible message itself.
async function createEventPost(
  channel: TextChannel | ForumChannel,
  event: EventWithRelations,
): Promise<{ thread: AnyThreadChannel; message: Message }> {
  const name = event.title.slice(0, 100);
  const payload = {
    embeds: buildEventEmbeds(event),
    components: buildEventComponents(event),
  };

  if (channel.type === ChannelType.GuildForum) {
    const thread = await channel.threads.create({
      name,
      autoArchiveDuration: THREAD_AUTO_ARCHIVE_MINUTES,
      message: payload,
      reason: "Event signup",
    });
    const message = await thread.fetchStarterMessage();
    if (!message)
      throw new Error("forum post created but starter message wasn't found");
    return { thread, message };
  }

  const message = await channel.send(payload);
  const thread = await message.startThread({
    name,
    autoArchiveDuration: THREAD_AUTO_ARCHIVE_MINUTES,
    reason: "Event discussion",
  });
  return { thread, message };
}

// Shared by the /guildthing event subcommand and the optional standing
// "Create new event" channel button (see ensureEventCreateButtons) — both
// just need something that can showModal()/awaitModalSubmit(), which a
// slash command and a button click equally are.
export async function handleEventCreateCommand(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
): Promise<void> {
  if (!interaction.guild) return;
  const guild = await db.guild.findUnique({
    where: { discordGuildId: interaction.guild.id },
  });
  if (!guild) {
    await interaction.reply({
      content: "This Discord server isn't registered with GuildThing.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // A dungeon-specific channel (e.g. Wailing Caverns) can have a saved
  // default role composition — pre-fills the Roles field instead of
  // retyping it every time, still editable right here before submitting.
  const preset = await db.eventChannelPreset.findUnique({
    where: {
      guildId_discordChannelId: {
        guildId: guild.id,
        discordChannelId: interaction.channelId,
      },
    },
  });

  const modal = new ModalBuilder()
    .setCustomId(`event-create-${interaction.id}`)
    .setTitle("Create an event")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("title")
          .setLabel("Title (e.g. Wailing Caverns)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("date")
          .setLabel("Date (YYYY-MM-DD)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(10)
          .setValue(todayISODate()),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("description")
          .setLabel("Description (optional)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(1000),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("roles")
          .setLabel("Roles, e.g. Tank:1:🛡️, Healer:1:✨, DPS:3")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(preset?.roles ?? ""),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("timeOptions")
          .setLabel("Time options, comma-separated (optional)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false),
      ),
    );

  await interaction.showModal(modal);
  let submitted: ModalSubmitInteraction;
  try {
    submitted = await interaction.awaitModalSubmit({
      time: MODAL_TIMEOUT_MS,
      filter: (i) =>
        i.user.id === interaction.user.id &&
        i.customId === modal.data.custom_id,
    });
  } catch {
    return;
  }

  const roleSlots = parseRoleSlots(submitted.fields.getTextInputValue("roles"));
  if (roleSlots.length === 0) {
    await submitted.reply({
      content:
        'Couldn\'t parse any roles from that — use the format "Name:Count" or "Name:Count:Emoji", e.g. "Tank:1:🛡️, Healer:1, DPS:3". Try again.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const timeOptionLabels = parseTimeOptions(
    submitted.fields.getTextInputValue("timeOptions") || null,
  );
  const date = parseEventDate(
    submitted.fields.getTextInputValue("date") || todayISODate(),
  );
  const description =
    submitted.fields.getTextInputValue("description").trim() || null;

  const created = await db.event.create({
    data: {
      guildId: guild.id,
      title: submitted.fields.getTextInputValue("title").trim(),
      date,
      description,
      createdByDiscordUserId: interaction.user.id,
      createdByDiscordTag: interaction.user.tag,
      discordChannelId: interaction.channelId,
      roleSlots: { create: roleSlots },
      timeOptions: { create: timeOptionLabels.map((label) => ({ label })) },
    },
    include: eventInclude,
  });

  // syncEventMessage does the actual thread-creation + posting — same code
  // path a web-created event's first sync goes through, so there's only
  // one place that knows how to stand up an event's thread.
  await syncEventMessage(submitted.client, created.id);
  const posted = await fetchEventWithRelations(created.id);
  await submitted.reply({
    content: posted?.discordThreadId
      ? `Created **${created.title}** — head to <#${posted.discordThreadId}> to sign up!`
      : `Created **${created.title}**, but I couldn't create its thread — check my permissions in this channel.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function promptTimeLabel(
  interaction: ButtonInteraction,
  eventId: string,
): Promise<string | null> {
  const modal = new ModalBuilder()
    .setCustomId(`event-addtime-${interaction.id}`)
    .setTitle("Add a time option")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("label")
          .setLabel("Time (e.g. 19:00-21:00)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(50),
      ),
    );
  await interaction.showModal(modal);
  try {
    const submitted = await interaction.awaitModalSubmit({
      time: MODAL_TIMEOUT_MS,
      filter: (i) =>
        i.user.id === interaction.user.id &&
        i.customId === modal.data.custom_id,
    });
    const label = submitted.fields.getTextInputValue("label").trim();
    await db.eventTimeOption.create({ data: { eventId, label } });
    const updated = await fetchEventWithRelations(eventId);
    // Always true here — this modal only ever comes from the "+ Add time
    // option" button — but isFromMessage() is what narrows the type enough
    // for TS to allow .update().
    if (updated && submitted.isFromMessage()) {
      await submitted.update({
        embeds: buildEventEmbeds(updated),
        components: buildEventComponents(updated),
      });
    }
    return label;
  } catch {
    return null;
  }
}

async function promptAddRoleModal(
  interaction: ButtonInteraction,
  eventId: string,
): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId(`event-addrole-${interaction.id}`)
    .setTitle("Add a role")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("roleName")
          .setLabel("Role name (e.g. Healer)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(50),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("capacity")
          .setLabel("How many people")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(3)
          .setValue("1"),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("emoji")
          .setLabel("Emoji (optional)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false),
      ),
    );
  await interaction.showModal(modal);
  try {
    const submitted = await interaction.awaitModalSubmit({
      time: MODAL_TIMEOUT_MS,
      filter: (i) =>
        i.user.id === interaction.user.id &&
        i.customId === modal.data.custom_id,
    });
    const roleName = submitted.fields.getTextInputValue("roleName").trim();
    const capacity = Math.max(
      1,
      Math.trunc(Number(submitted.fields.getTextInputValue("capacity")) || 1),
    );
    const emoji = submitted.fields.getTextInputValue("emoji").trim() || null;
    await db.eventRoleSlot.create({
      data: { eventId, roleName, capacity, emoji },
    });

    const updated = await fetchEventWithRelations(eventId);
    // Always true here — this modal only ever comes from the "+ Add role"
    // button — but isFromMessage() is what narrows the type enough for TS
    // to allow .update().
    if (updated && submitted.isFromMessage()) {
      await submitted.update({
        embeds: buildEventEmbeds(updated),
        components: buildEventComponents(updated),
      });
    }
  } catch {
    // Timed out or errored — nothing added.
  }
}

// Same title/image/looking-for fields as event creation, pre-filled with
// current values — roles and time options aren't editable here since they
// already have their own flows (role slots would need re-deriving existing
// signups, time options have "+ Add time option").
async function promptEditModal(
  interaction: ButtonInteraction,
  event: EventWithRelations,
): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId(`event-edit-${interaction.id}`)
    .setTitle("Edit event")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("title")
          .setLabel("Title")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100)
          .setValue(event.title),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("imageUrl")
          .setLabel("Image URL (optional)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setValue(event.imageUrl ?? ""),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("date")
          .setLabel("Date (YYYY-MM-DD)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(10)
          .setValue(event.date ?? todayISODate()),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("description")
          .setLabel("Description (optional)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(1000)
          .setValue(event.description ?? ""),
      ),
    );

  await interaction.showModal(modal);
  try {
    const submitted = await interaction.awaitModalSubmit({
      time: MODAL_TIMEOUT_MS,
      filter: (i) =>
        i.user.id === interaction.user.id &&
        i.customId === modal.data.custom_id,
    });

    await db.event.update({
      where: { id: event.id },
      data: {
        title: submitted.fields.getTextInputValue("title").trim(),
        imageUrl: submitted.fields.getTextInputValue("imageUrl").trim() || null,
        date: parseEventDate(
          submitted.fields.getTextInputValue("date") ||
            event.date ||
            todayISODate(),
        ),
        description:
          submitted.fields.getTextInputValue("description").trim() || null,
      },
    });

    const updated = await fetchEventWithRelations(event.id);
    // Always true here — this modal only ever comes from the Edit button —
    // but isFromMessage() is what narrows the type enough for TS to allow
    // .update().
    if (updated && submitted.isFromMessage()) {
      await submitted.update({
        embeds: buildEventEmbeds(updated),
        components: buildEventComponents(updated),
      });
    }
  } catch {
    // Timed out or errored — leave the event as it was.
  }
}

export async function handleEventComponentInteraction(
  interaction: StringSelectMenuInteraction | ButtonInteraction,
): Promise<void> {
  // customId is normally "event:{eventId}:{action}", but the role-signup
  // character picker (see "rolechar" below) needs a 4th segment carrying
  // which role slot the character choice belongs to.
  const [, eventId, action, extra] = interaction.customId.split(":");
  if (!eventId || !action) return;

  const event = await fetchEventWithRelations(eventId);
  if (!event || event.status === "cancelled") {
    await interaction
      .reply({
        content: "This event is no longer open.",
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }

  // Locked only settles the TIME, not who's signed up — role changes and
  // leaving stay allowed after lock (see buildEventComponents), but voting
  // or editing the time options themselves no longer makes sense once
  // it's decided.
  const TIME_LOCKED_ACTIONS = new Set([
    "vote",
    "addtime",
    "removetime",
    "removetimeselect",
    "lockin",
  ]);
  if (event.status !== "open" && TIME_LOCKED_ACTIONS.has(action)) {
    await interaction
      .reply({
        content: "The time's already locked in — can't change that anymore.",
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }

  if (action === "role" && interaction.isStringSelectMenu()) {
    const roleSlotId = interaction.values[0]!;
    const slot = event.roleSlots.find((s) => s.id === roleSlotId);
    if (!slot || slot.signups.length >= slot.capacity) {
      await interaction.reply({
        content: "That role just filled up — pick another.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const characters = await db.guildRosterMember.findMany({
      where: {
        guildId: event.guildId,
        claimedByDiscordUserId: interaction.user.id,
      },
      orderBy: { level: "desc" },
    });

    // More than one claimed character — ask which one instead of guessing
    // (previously always auto-picked the highest level). One or zero
    // characters has nothing to ask, so sign up immediately same as before.
    if (characters.length > 1) {
      await interaction.reply({
        content: `Which character is signing up for **${slot.roleName}**?`,
        flags: MessageFlags.Ephemeral,
        components: [
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`event:${eventId}:rolechar:${roleSlotId}`)
              .setPlaceholder("Select a character...")
              .addOptions(
                characters.map((c) => ({
                  label: c.class ? `${c.name} (${c.class})` : c.name,
                  value: c.id,
                  emoji: toSelectEmoji(classEmojiTag(c.class)),
                })),
              ),
          ),
        ],
      });
      return;
    }

    const rosterCharacter = characters[0] ?? null;
    await db.eventSignup.upsert({
      where: {
        eventId_discordUserId: { eventId, discordUserId: interaction.user.id },
      },
      create: {
        eventId,
        roleSlotId,
        discordUserId: interaction.user.id,
        discordUserTag: interaction.user.tag,
        characterName: rosterCharacter?.name ?? null,
        class: rosterCharacter?.class ?? null,
        isLeader: interaction.user.id === event.createdByDiscordUserId,
      },
      update: { roleSlotId },
    });
  } else if (action === "rolechar" && interaction.isStringSelectMenu()) {
    const roleSlotId = extra;
    const characterId = interaction.values[0]!;
    const slot = event.roleSlots.find((s) => s.id === roleSlotId);
    if (!roleSlotId || !slot || slot.signups.length >= slot.capacity) {
      await interaction.update({
        content: "That role just filled up — pick another from the main menu.",
        components: [],
      });
      return;
    }

    const character = await db.guildRosterMember.findUnique({
      where: { id: characterId },
    });

    await db.eventSignup.upsert({
      where: {
        eventId_discordUserId: { eventId, discordUserId: interaction.user.id },
      },
      create: {
        eventId,
        roleSlotId,
        discordUserId: interaction.user.id,
        discordUserTag: interaction.user.tag,
        characterName: character?.name ?? null,
        class: character?.class ?? null,
        isLeader: interaction.user.id === event.createdByDiscordUserId,
      },
      update: {
        roleSlotId,
        characterName: character?.name,
        class: character?.class,
      },
    });

    // This picker is its own ephemeral message, separate from the public
    // post — update the real one directly instead of via the generic
    // trailing renderToInteraction (which would wrongly target this
    // ephemeral message).
    await syncEventMessage(interaction.client, eventId);
    await interaction.update({
      content: `Signed up as **${character?.name ?? interaction.user.tag}**.`,
      components: [],
    });
    return;
  } else if (action === "vote" && interaction.isStringSelectMenu()) {
    const timeOptionId = interaction.values[0]!;
    await db.eventTimeVote.upsert({
      where: {
        eventId_discordUserId: { eventId, discordUserId: interaction.user.id },
      },
      create: { eventId, timeOptionId, discordUserId: interaction.user.id },
      update: { timeOptionId },
    });
  } else if (action === "leave" && interaction.isButton()) {
    await db.eventSignup.deleteMany({
      where: { eventId, discordUserId: interaction.user.id },
    });
  } else if (action === "cancel" && interaction.isButton()) {
    if (interaction.user.id !== event.createdByDiscordUserId) {
      await interaction.reply({
        content: "Only the person who created this event can cancel it.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await db.event.update({
      where: { id: eventId },
      data: { status: "cancelled" },
    });
    // Cancelling removes the post outright (clean, not just marked
    // cancelled) — acknowledge first since the message this interaction
    // came from is about to disappear. syncEventMessage does the actual
    // deletion (both the channel message and its attached thread, or the
    // forum post — whichever this event used), same cleanup path a
    // web-triggered cancel goes through.
    await interaction
      .reply({
        content: "Event cancelled — removing the post.",
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    await syncEventMessage(interaction.client, eventId);
    return;
  } else if (action === "addtime" && interaction.isButton()) {
    await promptTimeLabel(interaction, eventId);
    return; // promptTimeLabel already rendered via the modal submit interaction
  } else if (action === "edit" && interaction.isButton()) {
    if (interaction.user.id !== event.createdByDiscordUserId) {
      await interaction.reply({
        content: "Only the person who created this event can edit it.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await promptEditModal(interaction, event);
    return; // promptEditModal already rendered via the modal submit interaction
  } else if (action === "lockin" && interaction.isButton()) {
    if (interaction.user.id !== event.createdByDiscordUserId) {
      await interaction.reply({
        content: "Only the person who created this event can lock in the time.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // lockEvent already edits the real message via syncEventMessage, so
    // this just needs to close out the interaction without a second,
    // redundant edit.
    await lockEvent(interaction.client, event);
    await interaction.deferUpdate().catch(() => {});
    return;
  } else if (action === "removetime" && interaction.isButton()) {
    if (interaction.user.id !== event.createdByDiscordUserId) {
      await interaction.reply({
        content:
          "Only the person who created this event can remove a time option.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // A private picker rather than deleting straight from the public
    // message — a stray click here shouldn't be able to nuke someone
    // else's proposed time.
    await interaction.reply({
      content: "Which time option do you want to remove?",
      flags: MessageFlags.Ephemeral,
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`event:${eventId}:removetimeselect`)
            .setPlaceholder("Select a time option to remove...")
            .addOptions(
              event.timeOptions.map((t) => ({ label: t.label, value: t.id })),
            ),
        ),
      ],
    });
    return;
  } else if (
    action === "removetimeselect" &&
    interaction.isStringSelectMenu()
  ) {
    const timeOptionId = interaction.values[0]!;
    await db.eventTimeOption
      .delete({ where: { id: timeOptionId } })
      .catch(() => {
        // Already removed (e.g. someone else beat them to it) — fine.
      });
    await syncEventMessage(interaction.client, eventId);
    await interaction.update({
      content: 'Removed — add the corrected time with "+ Add time option".',
      components: [],
    });
    return;
  } else if (action === "addrole" && interaction.isButton()) {
    if (interaction.user.id !== event.createdByDiscordUserId) {
      await interaction.reply({
        content: "Only the person who created this event can add a role.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await promptAddRoleModal(interaction, eventId);
    return; // promptAddRoleModal already rendered via the modal submit interaction
  } else if (action === "removerole" && interaction.isButton()) {
    if (interaction.user.id !== event.createdByDiscordUserId) {
      await interaction.reply({
        content: "Only the person who created this event can remove a role.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (event.roleSlots.length === 0) {
      await interaction.reply({
        content: "There are no roles to remove.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // Removing a role drops whoever's signed up for it too (cascade) — the
    // option label shows that count up front so it's not a surprise.
    await interaction.reply({
      content: "Which role do you want to remove?",
      flags: MessageFlags.Ephemeral,
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`event:${eventId}:removeroleselect`)
            .setPlaceholder("Select a role to remove...")
            .addOptions(
              event.roleSlots.map((s) => ({
                label: `${s.roleName} (${s.signups.length}/${s.capacity})`,
                value: s.id,
                emoji: toSelectEmoji(s.emoji),
              })),
            ),
        ),
      ],
    });
    return;
  } else if (
    action === "removeroleselect" &&
    interaction.isStringSelectMenu()
  ) {
    const roleSlotId = interaction.values[0]!;
    await db.eventRoleSlot.delete({ where: { id: roleSlotId } }).catch(() => {
      // Already removed (e.g. someone else beat them to it) — fine.
    });
    await syncEventMessage(interaction.client, eventId);
    await interaction.update({
      content: "Removed.",
      components: [],
    });
    return;
  } else {
    return;
  }

  const updated = await fetchEventWithRelations(eventId);
  if (updated) await renderToInteraction(interaction, updated);
}

// Picks the winning time option (most votes; ties go to whichever was added
// first) and locks the event, or locks with no winner if nobody proposed a
// time at all — either way, "locked" just means signups/votes stop. Only
// triggered manually now (the "Lock in the time" button, creator-only) —
// there's no automatic timer, since guessing "everyone's voted" from a
// fixed timeout was never actually right for every event's size/urgency.
async function lockEvent(
  client: Client<true>,
  event: EventWithRelations,
): Promise<void> {
  const winner = event.timeOptions.reduce<{ id: string; votes: number } | null>(
    (best, t) => {
      if (!best || t.votes.length > best.votes)
        return { id: t.id, votes: t.votes.length };
      return best;
    },
    null,
  );

  await db.event.update({
    where: { id: event.id },
    data: { status: "locked", lockedTimeOptionId: winner?.id ?? null },
  });

  await syncEventMessage(client, event.id);
}

// Re-fetches an event and brings its Discord thread/message in line with
// current DB state — creates the thread if it doesn't exist yet (bot- or
// web-created events both funnel through here for that), edits the message
// in place for any other change, or deletes the thread outright once
// cancelled. Used by the auto-lock tick, syncPendingWebEvents, and directly
// by handleEventCreateCommand.
async function syncEventMessage(
  client: Client<true>,
  eventId: string,
): Promise<void> {
  const event = await fetchEventWithRelations(eventId);
  if (!event) return;
  const guildRow = await db.guild.findUnique({ where: { id: event.guildId } });
  if (!guildRow) return;
  const discordGuild = client.guilds.cache.get(guildRow.discordGuildId);
  if (!discordGuild) return;

  try {
    if (event.status === "cancelled") {
      // The attached thread and the channel message are two separate
      // objects for a text-channel event (see createEventPost) — deleting
      // one doesn't remove the other, so both need cleaning up. For a
      // forum event the "message" IS the thread, so the thread delete
      // alone already covers it.
      if (event.discordThreadId) {
        const thread = await discordGuild.channels
          .fetch(event.discordThreadId)
          .catch(() => null);
        await thread?.delete().catch(() => {});
      }
      const parentChannel = await discordGuild.channels
        .fetch(event.discordChannelId)
        .catch(() => null);
      // isTextBased() already excludes forum channels (they aren't
      // message-sendable directly), so this only matches the text-channel
      // case where the message is separate from the thread.
      if (event.discordMessageId && parentChannel?.isTextBased()) {
        const message = await parentChannel.messages
          .fetch(event.discordMessageId)
          .catch(() => null);
        await message?.delete().catch(() => {});
      }
      return;
    }

    const channel = await discordGuild.channels.fetch(event.discordChannelId);
    if (
      !channel ||
      (channel.type !== ChannelType.GuildText &&
        channel.type !== ChannelType.GuildForum)
    ) {
      console.error(
        `[bot] event ${event.id}'s channel ${event.discordChannelId} is neither a text nor forum channel — can't post`,
      );
      return;
    }

    if (!event.discordThreadId) {
      const { thread, message } = await createEventPost(channel, event);
      await db.event.update({
        where: { id: event.id },
        data: { discordThreadId: thread.id, discordMessageId: message.id },
      });
      return;
    }

    const payload = {
      embeds: buildEventEmbeds(event),
      components: buildEventComponents(event),
    };

    // Forum: the embed lives in the thread itself (it's the starter
    // message). Text channel: the embed is the channel message the thread
    // is merely attached to — edit it there instead.
    if (channel.type === ChannelType.GuildForum) {
      const thread = await discordGuild.channels
        .fetch(event.discordThreadId)
        .catch(() => null);
      if (!thread?.isThread()) return;

      const existing = event.discordMessageId
        ? await thread.messages.fetch(event.discordMessageId).catch(() => null)
        : null;
      if (existing) {
        await existing.edit(payload);
      } else {
        const message = await thread.send(payload);
        await db.event.update({
          where: { id: event.id },
          data: { discordMessageId: message.id },
        });
      }
    } else {
      const existing = event.discordMessageId
        ? await channel.messages.fetch(event.discordMessageId).catch(() => null)
        : null;
      if (existing) {
        await existing.edit(payload);
      } else {
        const message = await channel.send(payload);
        await db.event.update({
          where: { id: event.id },
          data: { discordMessageId: message.id },
        });
      }
    }
  } catch (err) {
    console.error(
      `[bot] failed to sync event thread/message for ${event.id}:`,
      err,
    );
  }
}

// Posts/updates events the website created or cancelled — same "web writes
// the DB + a flag, the bot's periodic tick notices and acts" pattern as
// forceSyncRequestedAt (see index.ts). Always clears the flag once
// attempted, even on failure — a bad/deleted channel shouldn't retry
// forever, same call as the join-nudge DM being best-effort only.
export async function syncPendingWebEvents(
  client: Client<true>,
): Promise<void> {
  const pending = await db.event.findMany({
    where: { pendingWebUpdate: true },
    select: { id: true },
  });
  for (const row of pending) {
    await syncEventMessage(client, row.id);
    await db.event.update({
      where: { id: row.id },
      data: { pendingWebUpdate: false },
    });
  }
}

// 24h after an event's own date (not creation date) has passed, auto-cancel
// it — same cleanup as clicking "Cancel group" (Discord thread/post
// deleted via syncEventMessage), except the DB row is kept as a cancelled
// record for history instead of being touched by whoever happens to notice
// and click it themselves. Events with no date set never expire this way —
// nothing to compare against.
export async function runEventExpiry(client: Client<true>): Promise<void> {
  const candidates = await db.event.findMany({
    where: { status: { not: "cancelled" }, date: { not: null } },
    select: { id: true, date: true },
  });

  for (const { id, date } of candidates) {
    if (!date || !ISO_DATE_PATTERN.test(date)) continue;
    const expiresAt =
      new Date(`${date}T00:00:00Z`).getTime() + 24 * 60 * 60_000;
    if (Date.now() < expiresAt) continue;

    await db.event.update({ where: { id }, data: { status: "cancelled" } });
    await syncEventMessage(client, id);
  }
}

export const EVENT_CREATE_BUTTON_ID = "event-create-button";

const EVENT_BUTTON_MESSAGE_TEXT =
  "Click below to create a new event signup in this channel.\nYou can always use the `/guildthing event` command as well.";

function buildEventCreateButtonMessage() {
  return {
    content: EVENT_BUTTON_MESSAGE_TEXT,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(EVENT_CREATE_BUTTON_ID)
          .setLabel("Create new event")
          .setStyle(ButtonStyle.Primary),
      ),
    ],
  };
}

// Same idea as ensureOnboardingButtons — keeps a standing "Create new
// event" button message current in every channel that's had it enabled
// (see EventChannelPreset.buttonEnabled), posting one if missing and
// cleaning up if it gets disabled. Idempotent, called on ready/GuildCreate
// and on a short interval (see index.ts) so an admin toggling it on the
// site lands quickly without a bot restart.
export async function ensureEventCreateButtons(
  client: Client<true>,
): Promise<void> {
  const presets = await db.eventChannelPreset.findMany({
    include: { guild: { select: { discordGuildId: true } } },
  });

  for (const preset of presets) {
    const discordGuild = client.guilds.cache.get(preset.guild.discordGuildId);
    if (!discordGuild) continue;

    if (!preset.buttonEnabled) {
      if (preset.buttonMessageId) {
        const channel = await discordGuild.channels
          .fetch(preset.discordChannelId)
          .catch(() => null);
        if (channel?.isTextBased()) {
          const existing = await channel.messages
            .fetch(preset.buttonMessageId)
            .catch(() => null);
          await existing?.delete().catch(() => {});
        }
        await db.eventChannelPreset.update({
          where: { id: preset.id },
          data: { buttonMessageId: null },
        });
      }
      continue;
    }

    try {
      const channel = await discordGuild.channels.fetch(
        preset.discordChannelId,
      );
      if (!channel?.isTextBased()) continue;

      if (preset.buttonMessageId) {
        const existing = await channel.messages
          .fetch(preset.buttonMessageId)
          .catch(() => null);
        if (existing) continue; // already posted, nothing to change
      }

      const message = await channel.send(buildEventCreateButtonMessage());
      await db.eventChannelPreset.update({
        where: { id: preset.id },
        data: { buttonMessageId: message.id },
      });
    } catch (err) {
      console.error(
        `[bot] failed to ensure event-create button for channel ${preset.discordChannelId}:`,
        err,
      );
    }
  }
}

// Checks whether each channel's create-event button is still the last
// message there — if someone's posted since, drops the bookkeeping (and
// best-effort deletes the now-stale button) so the next
// ensureEventCreateButtons pass reposts a fresh one at the current bottom.
// Cheap (one message fetch per button-enabled channel) but deliberately
// NOT run on a short/eager interval like the rest of the event tick — see
// EVENT_BUTTON_DRIFT_CHECK_INTERVAL_MS in index.ts. Reactive to actual
// activity rather than reposting (and re-notifying the channel) on a fixed
// clock regardless of whether anything's happened.
export async function repostDriftedEventButtons(
  client: Client<true>,
): Promise<void> {
  const presets = await db.eventChannelPreset.findMany({
    where: { buttonEnabled: true, buttonMessageId: { not: null } },
    include: { guild: { select: { discordGuildId: true } } },
  });

  for (const preset of presets) {
    const discordGuild = client.guilds.cache.get(preset.guild.discordGuildId);
    if (!discordGuild || !preset.buttonMessageId) continue;

    try {
      const channel = await discordGuild.channels.fetch(
        preset.discordChannelId,
      );
      if (!channel?.isTextBased()) continue;

      const latest = (await channel.messages.fetch({ limit: 1 })).first();
      if (!latest || latest.id === preset.buttonMessageId) continue;

      const stale = await channel.messages
        .fetch(preset.buttonMessageId)
        .catch(() => null);
      await stale?.delete().catch(() => {});
      await db.eventChannelPreset.update({
        where: { id: preset.id },
        data: { buttonMessageId: null },
      });
    } catch (err) {
      console.error(
        `[bot] failed to check event-create button drift for channel ${preset.discordChannelId}:`,
        err,
      );
    }
  }
}

const BUTTON_REPOST_DEBOUNCE_MS = 5_000;
// Per-channel-preset debounce timers — a burst of messages in the same
// channel should only trigger one repost, not one per message.
const pendingButtonReposts = new Map<string, NodeJS.Timeout>();

// Guards against the repost triggering itself: sending the new button
// message is its own MessageCreate event, and — before the buttonMessageId
// DB update below has landed — that fresh message doesn't look like the
// recorded button yet, so scheduleEventButtonRepostOnMessage would treat it
// as "something new" and schedule *another* repost, forever, once per
// debounce interval. Held only for the couple seconds this race is
// possible, not permanently — a genuinely different bot-authored message
// (e.g. a newly posted event embed) still triggers a reposition normally.
const selfRepostGuard = new Set<string>();

async function repostSingleEventButton(
  client: Client<true>,
  presetId: string,
): Promise<void> {
  const preset = await db.eventChannelPreset.findUnique({
    where: { id: presetId },
    include: { guild: { select: { discordGuildId: true } } },
  });
  if (!preset?.buttonEnabled) return;

  const discordGuild = client.guilds.cache.get(preset.guild.discordGuildId);
  if (!discordGuild) return;

  selfRepostGuard.add(presetId);
  try {
    const channel = await discordGuild.channels.fetch(preset.discordChannelId);
    if (!channel?.isTextBased()) return;

    if (preset.buttonMessageId) {
      const stale = await channel.messages
        .fetch(preset.buttonMessageId)
        .catch(() => null);
      await stale?.delete().catch(() => {});
    }

    const message = await channel.send(buildEventCreateButtonMessage());
    await db.eventChannelPreset.update({
      where: { id: preset.id },
      data: { buttonMessageId: message.id },
    });
  } catch (err) {
    console.error(
      `[bot] failed to reposition event-create button for channel ${preset.discordChannelId}:`,
      err,
    );
  } finally {
    setTimeout(() => selfRepostGuard.delete(presetId), 2_000);
  }
}

// Reacts to a new message in real time instead of waiting for the next
// poll (see repostDriftedEventButtons, kept as a slower fallback for
// anything this misses — e.g. a bot restart losing an in-flight debounce
// timer): if the channel has an enabled create-event button that isn't
// already the last message, wait a few seconds (in case more messages are
// about to land in the same burst) and then move it back to the bottom.
// Reacts to bot-authored messages too (e.g. a newly posted event embed
// should push the button down) — selfRepostGuard is what specifically
// stops the repost from re-triggering itself, not a blanket bot filter.
export function scheduleEventButtonRepostOnMessage(
  client: Client<true>,
  message: { guildId: string | null; channelId: string; id: string },
): void {
  if (!message.guildId) return;

  void db.eventChannelPreset
    .findFirst({
      where: {
        discordChannelId: message.channelId,
        buttonEnabled: true,
        buttonMessageId: { not: null },
        guild: { discordGuildId: message.guildId },
      },
    })
    .then((preset) => {
      if (
        !preset ||
        message.id === preset.buttonMessageId ||
        selfRepostGuard.has(preset.id)
      ) {
        return;
      }

      const existing = pendingButtonReposts.get(preset.id);
      if (existing) clearTimeout(existing);

      pendingButtonReposts.set(
        preset.id,
        setTimeout(() => {
          pendingButtonReposts.delete(preset.id);
          repostSingleEventButton(client, preset.id).catch((err: unknown) => {
            console.error(
              `[bot] failed to reposition event-create button for channel ${message.channelId}:`,
              err,
            );
          });
        }, BUTTON_REPOST_DEBOUNCE_MS),
      );
    })
    .catch((err: unknown) => {
      console.error(
        `[bot] failed to check event-create button preset for channel ${message.channelId}:`,
        err,
      );
    });
}
