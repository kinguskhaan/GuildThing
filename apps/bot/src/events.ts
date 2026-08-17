import {
  ActionRowBuilder,
  type AnyThreadChannel,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  ChannelType,
  type ChatInputCommandInteraction,
  type Client,
  ComponentType,
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
  // Absence entries have no roleSlotId, so they'd never show up via
  // roleSlots.signups above — fetched separately here instead.
  signups: { where: { status: "absence" } },
} as const;

interface EventWithRelations {
  id: string;
  guildId: string;
  title: string;
  imageUrl: string | null;
  date: string | null;
  description: string | null;
  allowTimeSuggestions: boolean;
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
      status: string;
    }[];
  }[];
  signups: {
    discordUserId: string;
    characterName: string | null;
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

function todayISODate(): string {
  return new Date().toISOString().slice(0, 10);
}

// Used as the create-modal's date placeholder — a real, always-current
// example (instead of a date that ages into the past) nudges people
// towards the right format without them having to work out today's date
// themselves first.
function tomorrowISODate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Best-effort, not strict like parseEventDateTime below — these are extra
// alternatives someone types straight into chat, not the anchor time, so a
// stray typo shouldn't blow up the whole list.
function parseTimeOptions(input: string): string[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Strict on purpose (unlike parseRoleSlots/parseEventDate's best-effort
// fallbacks) — this becomes the event's actual first time option, so
// silently accepting garbage would just produce a confusing "TBD"-looking
// time later instead of telling the user right away what's wrong.
// "YYYY-MM-DD HH:MM" (24h; a literal "T" separator works too), with real
// calendar validation (rejects e.g. 2026-02-30, not just wrong digit
// counts) and hour/minute range checks baked into the regex itself.
const DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[ T]([01]\d|2[0-3]):([0-5]\d)$/;

function parseEventDateTime(
  input: string,
): { date: string; time: string } | null {
  const match = DATE_TIME_PATTERN.exec(input.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const asDate = new Date(y, m - 1, d);
  if (
    asDate.getFullYear() !== y ||
    asDate.getMonth() !== m - 1 ||
    asDate.getDate() !== d
  ) {
    return null;
  }
  return { date: `${year}-${month}-${day}`, time: `${hour}:${minute}` };
}

const TIME_ONLY_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Strict, same spirit as parseEventDateTime above — this is the "+ Add time
// option" button, so garbage like "26:00" shouldn't silently become a
// votable option. Comma-separated so one submission can add several start
// times at once; returns null (reject the whole batch) if ANY entry is
// invalid, rather than silently dropping the bad one.
function parseTimeList(input: string): string[] | null {
  const parts = input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  return parts.every((p) => TIME_ONLY_PATTERN.test(p)) ? parts : null;
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Date-only version for the Edit modal, which doesn't touch time options.
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

// Tentative signups don't consume slot capacity — a "maybe" shouldn't hold
// the last spot and block someone who can actually commit, e.g. a single
// tentative tank locking out every other tank from a 1-capacity slot.
function confirmedSignupCount(slot: { signups: { status: string }[] }): number {
  return slot.signups.filter((su) => su.status !== "tentative").length;
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
  const totalConfirmed = event.roleSlots.reduce(
    (sum, s) => sum + confirmedSignupCount(s),
    0,
  );
  const totalTentative = event.roleSlots.reduce(
    (sum, s) =>
      sum + s.signups.filter((su) => su.status === "tentative").length,
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
        value:
          totalTentative > 0
            ? `${totalConfirmed}/${totalCapacity} (${totalTentative} tentative)`
            : `${totalConfirmed}/${totalCapacity}`,
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

  if (event.timeOptions.length === 1 && !event.allowTimeSuggestions) {
    // Exactly one fixed time, suggestions off — nothing to vote on, so
    // showing a vote bar for the only option is just noise. Plain display
    // instead.
    embed.addFields(spacer, {
      name: "Time",
      value: event.timeOptions[0]!.label,
    });
  } else if (event.timeOptions.length > 0) {
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
            const tentativeSuffix =
              s.status === "tentative" ? " *(tentative)*" : "";
            return `\`${i + 1}\` ${displayName}${classSuffix}${tentativeSuffix}`;
          })
          .join("\n")
      : "_empty_";
    embed.addFields({
      name: `${slot.emoji ? `${slot.emoji} ` : ""}${slot.roleName} (${confirmedSignupCount(slot)}/${slot.capacity})`,
      value: lines,
      inline: false,
    });
  }

  if (event.signups.length > 0) {
    embed.addFields({
      name: `🚫 Absence (${event.signups.length})`,
      value: event.signups
        .map(
          (s, i) =>
            `\`${i + 1}\` ${s.characterName ?? `<@${s.discordUserId}>`}`,
        )
        .join("\n"),
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
    (s) => confirmedSignupCount(s) < s.capacity,
  );
  if (openSlots.length > 0) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`event:${event.id}:role`)
          .setPlaceholder("Sign up for a role...")
          .addOptions(
            openSlots.map((s) => ({
              label: `${s.roleName} (${confirmedSignupCount(s)}/${s.capacity} taken)`,
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

  // A single fixed time (suggestions off) has nothing to vote between —
  // skip the select entirely instead of offering a one-option "vote".
  const votingMeaningful =
    event.timeOptions.length > 1 ||
    (event.timeOptions.length === 1 && event.allowTimeSuggestions);
  if (isOpen && votingMeaningful) {
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
  }

  if (isOpen) {
    // No lock-in step — voting just stays open, and whoever's looking can
    // see which time has the most votes right on the embed. Picking a
    // mistaken time (e.g. a typo) also has no direct "edit" — remove it and
    // add the corrected one instead. allowTimeSuggestions off hides "+ Add
    // time option" entirely — for a fixed time with no discussion wanted,
    // rather than fighting off randoms tacking on alternatives. All gated
    // to the creator except adding, same as Edit/Cancel.
    const timeButtons: ButtonBuilder[] = [];
    if (event.allowTimeSuggestions) {
      timeButtons.push(
        new ButtonBuilder()
          .setCustomId(`event:${event.id}:addtime`)
          .setLabel("+ Add time option")
          .setStyle(ButtonStyle.Secondary),
      );
    }
    // Always keep at least one time — an event with zero times has nothing
    // to show as its date/time at all.
    if (event.timeOptions.length > 1) {
      timeButtons.push(
        new ButtonBuilder()
          .setCustomId(`event:${event.id}:removetime`)
          .setLabel("Remove a time option")
          .setStyle(ButtonStyle.Secondary),
      );
    }
    timeButtons.push(
      new ButtonBuilder()
        .setCustomId(`event:${event.id}:toggletimesuggest`)
        .setLabel(
          event.allowTimeSuggestions
            ? "🔕 Disable time suggestions"
            : "🔔 Enable time suggestions",
        )
        .setStyle(ButtonStyle.Secondary),
    );
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(timeButtons));
  }

  const actionButtons = [
    // Marks the clicker absent — clears any role signup they had and puts
    // them in the dedicated Absence list instead of just removing them
    // silently, so the roster shows who's confirmed NOT coming, not just
    // who never answered. Clicking again while already absent clears it
    // entirely (back to no signup at all).
    new ButtonBuilder()
      .setCustomId(`event:${event.id}:absence`)
      .setLabel("Absence")
      .setStyle(ButtonStyle.Secondary),
    // Flips the clicker's own signup between confirmed/tentative — usable
    // any time after signing up, lock included (still meaningful then:
    // "actually not sure I can make it anymore" doesn't stop being true
    // just because the time's decided).
    new ButtonBuilder()
      .setCustomId(`event:${event.id}:tentative`)
      .setLabel("Toggle tentative")
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
  existingMessageId: string | null,
): Promise<{ thread: AnyThreadChannel | null; message: Message }> {
  const name = event.title.slice(0, 100);
  const payload = {
    embeds: buildEventEmbeds(event),
    components: buildEventComponents(event),
  };

  if (channel.type === ChannelType.GuildForum) {
    // A forum post's message and thread are the same Discord object,
    // created together — no partial-failure state possible here the way
    // there is below, so no existingMessageId reuse needed.
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

  // A previous attempt may have already sent the message but failed to
  // attach a thread (e.g. missing "Create Public Threads" in this specific
  // channel) — reuse that message instead of posting a duplicate on every
  // retry. Falls through to sending a fresh one if it's since been deleted.
  const message =
    (existingMessageId
      ? await channel.messages.fetch(existingMessageId).catch(() => null)
      : null) ?? (await channel.send(payload));

  try {
    const thread = await message.startThread({
      name,
      autoArchiveDuration: THREAD_AUTO_ARCHIVE_MINUTES,
      reason: "Event discussion",
    });
    return { thread, message };
  } catch (err) {
    console.error(
      `[bot] posted event message for ${event.id} but couldn't attach a thread (likely missing "Create Public Threads" in that channel):`,
      err,
    );
    return { thread: null, message };
  }
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

  // One modal, 5 fields — Discord's hard server-side cap (confirmed live,
  // both the classic ActionRow<TextInput> system and the newer Label one
  // hit the same "must be 5 or fewer" error). Extra time options and
  // toggling "allow suggestions" both stay reachable after posting, via
  // the "+ Add time option" / "🔕 Disable time suggestions" buttons — no
  // multi-step question chain needed for those.
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
          .setCustomId("dateTime")
          .setLabel("Date & time (YYYY-MM-DD HH:MM)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(16)
          .setPlaceholder(`e.g. ${tomorrowISODate()} 20:00`),
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
          .setCustomId("imageUrl")
          .setLabel("GIF/Image URL to be shown (optional)")
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

  const dateTime = parseEventDateTime(
    submitted.fields.getTextInputValue("dateTime"),
  );
  if (!dateTime) {
    await submitted.reply({
      content:
        `Couldn't parse that date/time — use YYYY-MM-DD HH:MM (24h), e.g. ${tomorrowISODate()} 20:00. Try again.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (new Date(`${dateTime.date}T${dateTime.time}:00`).getTime() < Date.now()) {
    await submitted.reply({
      content:
        "That date/time has already passed — pick something in the future. Try again.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const title = submitted.fields.getTextInputValue("title").trim();
  const description =
    submitted.fields.getTextInputValue("description").trim() || null;
  const imageUrlInput = submitted.fields.getTextInputValue("imageUrl").trim();
  const imageUrl = /^https?:\/\//.test(imageUrlInput) ? imageUrlInput : null;

  // The date/time field is always the first (and, unless more get added
  // below or later via "+ Add time option", only) time option.
  const timeLabels: string[] = [dateTime.time];

  // Cursor for whichever interaction is currently "live" — askYesNo below
  // is smart about reply vs update vs followUp based on its state, so this
  // doesn't need to track "is it still fresh" itself.
  let cursor: ModalSubmitInteraction | ButtonInteraction = submitted;

  const moreTimes = await askYesNo(
    cursor,
    "Would you like to add more time options for people to vote on?",
    "Yes",
    "No",
  );
  if (moreTimes?.value) {
    // moreTimes.interaction is a freshly-clicked, not-yet-acknowledged
    // ButtonInteraction (askYesNo/notify never reply/update/defer it before
    // returning it) — showModal() is a valid first response on it, same as
    // any slash-command or button interaction elsewhere in this file.
    const timesModal = new ModalBuilder()
      .setCustomId(`event-moretimes-${moreTimes.interaction.id}`)
      .setTitle("Add more times")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("times")
            .setLabel("Times, comma-separated (e.g. 22:00, 23:00)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(200),
        ),
      );
    await moreTimes.interaction.showModal(timesModal);
    try {
      const timesSubmitted = await moreTimes.interaction.awaitModalSubmit({
        time: MODAL_TIMEOUT_MS,
        filter: (i) =>
          i.user.id === interaction.user.id &&
          i.customId === timesModal.data.custom_id,
      });
      timeLabels.push(
        ...parseTimeOptions(timesSubmitted.fields.getTextInputValue("times")),
      );
      // Now the live interaction for anything that follows — unlike the
      // showModal()-consumed button interaction above, this one hasn't
      // been replied to yet.
      cursor = timesSubmitted;
    } catch {
      // Modal dismissed or timed out — no extra times. `cursor` stays
      // `submitted`, which notify() already replied to earlier in
      // askYesNo, so later calls fall through to followUp() safely
      // instead of trying to reply/update the now-consumed button
      // interaction above.
    }
  } else if (moreTimes) {
    cursor = moreTimes.interaction;
  }

  const allowSuggestions = await askYesNo(
    cursor,
    "Do you want to allow people to add their own time suggestions that others can vote on?",
    "Yes",
    "No",
  );
  if (allowSuggestions) cursor = allowSuggestions.interaction;
  const allowTimeSuggestions = allowSuggestions?.value ?? true;

  const created = await db.event.create({
    data: {
      guildId: guild.id,
      title,
      date: dateTime.date,
      description,
      imageUrl,
      allowTimeSuggestions,
      createdByDiscordUserId: interaction.user.id,
      createdByDiscordTag: interaction.user.tag,
      discordChannelId: interaction.channelId,
      roleSlots: { create: roleSlots },
      timeOptions: { create: timeLabels.map((label) => ({ label })) },
    },
    include: eventInclude,
  });

  // syncEventMessage does the actual thread-creation + posting — same code
  // path a web-created event's first sync goes through, so there's only
  // one place that knows how to stand up an event's thread.
  await syncEventMessage(submitted.client, created.id);
  const posted = await fetchEventWithRelations(created.id);
  const confirmation = posted?.discordThreadId
    ? `Created **${created.title}** — head to <#${posted.discordThreadId}> to sign up!`
    : `Created **${created.title}**, but I couldn't create its thread — check my permissions in this channel.`;
  await notify(cursor, confirmation);
}

// Ephemeral Yes/No question via buttons. Smart about how to respond to
// `interaction` — reply (unacknowledged modal submit), update (unacknowledged
// button), or followUp (already acknowledged either way) — so callers can
// just chain these one after another without tracking acknowledgment state
// themselves.
async function askYesNo(
  interaction: ModalSubmitInteraction | ButtonInteraction,
  content: string,
  yesLabel: string,
  noLabel: string,
): Promise<{ value: boolean; interaction: ButtonInteraction } | null> {
  const yesId = `yn-yes-${interaction.id}`;
  const noId = `yn-no-${interaction.id}`;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(yesId)
      .setLabel(yesLabel)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(noId)
      .setLabel(noLabel)
      .setStyle(ButtonStyle.Secondary),
  );

  const message = await notify(interaction, content, [row]);
  if (!message) return null;

  try {
    const clicked = await message.awaitMessageComponent({
      componentType: ComponentType.Button,
      time: MODAL_TIMEOUT_MS,
      filter: (i) => i.user.id === interaction.user.id,
    });
    return { value: clicked.customId === yesId, interaction: clicked };
  } catch {
    return null;
  }
}

// Sends `content` via whichever response method `interaction` still
// accepts — reply, update, or followUp — and returns the resulting
// message, or null if even that failed (interaction expired entirely).
async function notify(
  interaction: ModalSubmitInteraction | ButtonInteraction,
  content: string,
  components: ActionRowBuilder<ButtonBuilder>[] = [],
): Promise<Message | null> {
  try {
    if (interaction.replied || interaction.deferred) {
      return await interaction.followUp({
        content,
        components,
        flags: MessageFlags.Ephemeral,
      });
    }
    if (interaction.isButton()) {
      await interaction.update({ content, components });
    } else {
      await interaction.reply({
        content,
        components,
        flags: MessageFlags.Ephemeral,
      });
    }
    return await interaction.fetchReply();
  } catch (err) {
    console.error(`[bot] failed to notify ${interaction.user.tag}:`, err);
    return null;
  }
}

async function promptTimeLabel(
  interaction: ButtonInteraction,
  eventId: string,
): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId(`event-addtime-${interaction.id}`)
    .setTitle("Add a time option")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("label")
          .setLabel("Start time(s) — HH:MM, comma for more")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100)
          .setPlaceholder("e.g. 19:00 or 19:00, 20:30"),
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
    const times = parseTimeList(submitted.fields.getTextInputValue("label"));
    if (!times) {
      await submitted.reply({
        content:
          "Couldn't parse that — use 24h HH:MM, comma-separated for more than one, e.g. `19:00, 20:30`. Try again.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await db.eventTimeOption.createMany({
      data: times.map((label) => ({ eventId, label })),
    });
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
  } catch {
    // Modal dismissed or timed out — nothing to add.
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

  // No manual lock-in step anymore — voting just stays open for the
  // event's whole life. This only still matters for events locked before
  // that feature was removed (their status is stuck at "locked" rather
  // than "open"), so those don't suddenly reopen voting.
  const TIME_LOCKED_ACTIONS = new Set([
    "vote",
    "addtime",
    "removetime",
    "removetimeselect",
    "toggletimesuggest",
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
    if (!slot || confirmedSignupCount(slot) >= slot.capacity) {
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
      },
      // Picking a role is a fresh, deliberate "I'm doing this" — always
      // resets status to confirmed, overriding a prior tentative or
      // absence state rather than leaving it stuck.
      update: { roleSlotId, status: "confirmed" },
    });
  } else if (action === "rolechar" && interaction.isStringSelectMenu()) {
    const roleSlotId = extra;
    const characterId = interaction.values[0]!;
    const slot = event.roleSlots.find((s) => s.id === roleSlotId);
    if (!roleSlotId || !slot || confirmedSignupCount(slot) >= slot.capacity) {
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
      },
      update: {
        roleSlotId,
        characterName: character?.name,
        class: character?.class,
        status: "confirmed",
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
  } else if (action === "absence" && interaction.isButton()) {
    // event.signups only ever holds status:"absence" rows (see
    // eventInclude) — present means this user's already marked absent, so
    // clicking again clears it instead of being stuck absent forever.
    const alreadyAbsent = event.signups.some(
      (s) => s.discordUserId === interaction.user.id,
    );
    if (alreadyAbsent) {
      await db.eventSignup.deleteMany({
        where: { eventId, discordUserId: interaction.user.id },
      });
    } else {
      await db.eventSignup.upsert({
        where: {
          eventId_discordUserId: {
            eventId,
            discordUserId: interaction.user.id,
          },
        },
        // Clears any role signup they had — being absent means not doing
        // any role, not just stepping back from this particular one.
        create: {
          eventId,
          discordUserId: interaction.user.id,
          discordUserTag: interaction.user.tag,
          status: "absence",
        },
        update: { roleSlotId: null, status: "absence" },
      });
    }
  } else if (action === "tentative" && interaction.isButton()) {
    const signup = event.roleSlots
      .flatMap((s) => s.signups.map((su) => ({ ...su, roleSlotId: s.id })))
      .find((su) => su.discordUserId === interaction.user.id);
    if (!signup) {
      await interaction.reply({
        content: "Sign up for a role first, then you can toggle tentative.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // Going tentative always frees the spot, no capacity check needed. Going
    // back to confirmed can run into a slot someone else filled in the
    // meantime (that's the whole point of freeing it up) — block that
    // instead of silently overbooking the role.
    if (signup.status === "tentative") {
      const slot = event.roleSlots.find((s) => s.id === signup.roleSlotId);
      if (slot && confirmedSignupCount(slot) >= slot.capacity) {
        await interaction.reply({
          content:
            "That role's full now — someone else took the spot while you were tentative. Pick another role from the menu instead.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }
    await db.eventSignup.update({
      where: {
        eventId_discordUserId: { eventId, discordUserId: interaction.user.id },
      },
      data: {
        status: signup.status === "tentative" ? "confirmed" : "tentative",
      },
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
  } else if (action === "toggletimesuggest" && interaction.isButton()) {
    if (interaction.user.id !== event.createdByDiscordUserId) {
      await interaction.reply({
        content:
          "Only the person who created this event can toggle time suggestions.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await db.event.update({
      where: { id: eventId },
      data: { allowTimeSuggestions: !event.allowTimeSuggestions },
    });
  } else if (action === "removetime" && interaction.isButton()) {
    if (interaction.user.id !== event.createdByDiscordUserId) {
      await interaction.reply({
        content:
          "Only the person who created this event can remove a time option.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (event.timeOptions.length <= 1) {
      await interaction.reply({
        content:
          "Can't remove the only time option — add another one first, or edit this one instead.",
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
    // Re-checked fresh from the DB rather than trusting the `event` object
    // from before this picker was shown — someone else could've removed a
    // different option in the meantime, and there must always be at least
    // one left.
    const remaining = await db.eventTimeOption.count({ where: { eventId } });
    if (remaining <= 1) {
      await interaction.update({
        content: "Can't remove that — it's the only time option left.",
        components: [],
      });
      return;
    }
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
      const { thread, message } = await createEventPost(
        channel,
        event,
        event.discordMessageId,
      );
      await db.event.update({
        where: { id: event.id },
        data: {
          discordMessageId: message.id,
          ...(thread ? { discordThreadId: thread.id } : {}),
        },
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

function buildEventCreateButtonMessage(customText?: string | null) {
  return {
    content: customText?.trim() || EVENT_BUTTON_MESSAGE_TEXT,
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

      const desired = buildEventCreateButtonMessage(preset.buttonMessageText);

      if (preset.buttonMessageId) {
        const existing = await channel.messages
          .fetch(preset.buttonMessageId)
          .catch(() => null);
        if (existing) {
          if (existing.content !== desired.content) {
            await existing.edit(desired);
          }
          continue;
        }
      }

      const message = await channel.send(desired);
      await db.eventChannelPreset.update({
        where: { id: preset.id },
        data: { buttonMessageId: message.id, lastButtonRepostAt: new Date() },
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

const DAILY_BUTTON_REPOST_INTERVAL_MS = 24 * 60 * 60 * 1_000;

// Counterpart to the live per-message repost path, for buttonRepostMode
// "daily": moves the button back to the bottom at most once every 24h,
// rather than tracking every new message individually. A preset that's
// never been reposted (lastButtonRepostAt null — e.g. just switched into
// "daily" mode) is treated as due immediately.
//
// Only actually reposts if something's been posted in the channel since
// the button went up — deleting+resending it when it's already the last
// message would just mark the channel unread/re-notify everyone for no
// reason (the exact complaint that led to this check). A due-but-still-
// current preset is left with its old lastButtonRepostAt so it gets
// re-checked on every following tick instead of waiting out another full
// 24h — the button still moves promptly once real activity happens.
export async function repostDailyEventButtons(
  client: Client<true>,
): Promise<void> {
  const presets = await db.eventChannelPreset.findMany({
    where: {
      buttonEnabled: true,
      buttonMessageId: { not: null },
      buttonRepostMode: "daily",
    },
    include: { guild: { select: { discordGuildId: true } } },
  });

  const now = Date.now();
  for (const preset of presets) {
    const due =
      !preset.lastButtonRepostAt ||
      now - preset.lastButtonRepostAt.getTime() >= DAILY_BUTTON_REPOST_INTERVAL_MS;
    if (!due || !preset.buttonMessageId) continue;

    const discordGuild = client.guilds.cache.get(preset.guild.discordGuildId);
    if (!discordGuild) continue;

    try {
      const channel = await discordGuild.channels.fetch(
        preset.discordChannelId,
      );
      if (!channel?.isTextBased()) continue;

      const latest = (await channel.messages.fetch({ limit: 1 })).first();
      if (latest && latest.id === preset.buttonMessageId) continue; // still at the bottom — nothing to do
    } catch (err) {
      console.error(
        `[bot] failed to check channel activity before daily button repost for ${preset.discordChannelId}:`,
        err,
      );
      continue;
    }

    await repostSingleEventButton(client, preset.id).catch((err: unknown) => {
      console.error(
        `[bot] failed to run daily repost for channel ${preset.discordChannelId}:`,
        err,
      );
    });
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

    const message = await channel.send(
      buildEventCreateButtonMessage(preset.buttonMessageText),
    );
    await db.eventChannelPreset.update({
      where: { id: preset.id },
      data: { buttonMessageId: message.id, lastButtonRepostAt: new Date() },
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
// Skipped entirely for buttonRepostMode "daily" — that mode's button is
// meant to sit still between its once-a-day reposts (see
// repostDailyEventButtons) rather than track the channel's activity.
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
        preset.buttonRepostMode === "daily" ||
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
