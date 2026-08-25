import {
  Client,
  Events,
  GatewayIntentBits,
  type Guild,
  PermissionFlagsBits,
  Routes,
  SlashCommandBuilder,
} from "discord.js";

import { db } from "@guildthing/db";

import {
  handleReactivate,
  initializeMemberActivity,
  removeMemberActivity,
  runInactivityFilter,
  trackMessageActivity,
} from "./activityTracking.js";
import {
  cancelOnboarding,
  notifyNewMemberToOnboard,
  runOnboardingInteractive,
} from "./onboarding.js";
import {
  ensureOnboardingButtons,
  START_ONBOARDING_BUTTON_ID,
} from "./onboardingButton.js";
import {
  ensureEventCreateButtons,
  repostDailyEventButtons,
  EVENT_CREATE_BUTTON_ID,
  handleEventComponentInteraction,
  handleEventCreateCommand,
  repostDriftedEventButtons,
  runEventExpiry,
  scheduleEventButtonRepostOnMessage,
  syncPendingWebEvents,
} from "./events.js";
import {
  handleCraftAutocomplete,
  handleCraftCommand,
  handleCraftShareButton,
} from "./craftLookup.js";
import { handleRoleDiffCommand, handleSyncRosterCommand } from "./bossman.js";
import { syncExternalCharacters } from "./externalCharacters.js";
import { syncPendingRosterMatches } from "./pendingMatches.js";
import { ROLE_SYNC_INTERVAL_MS, runFullRoleSync } from "./roleSync.js";

// How often to check whether any guild's onboarding-button channel changed
// (new one set, old one cleared) and needs its message posted/reposted.
// Much shorter than the daily roster sync — this is a one-time admin
// action, so it should feel close to instant, not wait up to a day.
const ONBOARDING_BUTTON_CHECK_INTERVAL_MS = 60_000;

// How often to check for a "Sync now" request from the site (see
// Guild.forceSyncRequestedAt) — short enough that clicking the button feels
// close to instant instead of waiting for the once-a-day automatic sync.
const FORCE_SYNC_CHECK_INTERVAL_MS = 15_000;

// How often to post web-created events to Discord and clean up expired
// ones — short enough that creating an event on the site feels close to
// instant, same reasoning as FORCE_SYNC_CHECK_INTERVAL_MS.
const EVENT_TICK_INTERVAL_MS = 15_000;

// How often to check whether a channel's create-event button has drifted
// away from the bottom (someone posted after it). One fetch per
// button-enabled channel per check is cheap enough to run this often
// without worrying about Discord's rate limits.
const EVENT_BUTTON_DRIFT_CHECK_INTERVAL_MS = 60_000;

// How often to check whether a "daily" repost-mode button is due for its
// once-a-day reposition (see repostDailyEventButtons). Doesn't need to be
// precise to the minute — checking every 15min keeps the actual repost
// within 15min of the 24h mark, which is plenty for something meant to
// happen once a day.
const DAILY_BUTTON_REPOST_CHECK_INTERVAL_MS = 15 * 60_000;

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  throw new Error("DISCORD_BOT_TOKEN is not set");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    // For the GuildMemberAdd join-nudge and fetching members during
    // onboarding.
    GatewayIntentBits.GuildMembers,
    // For the inactivity filter's activity tracking (trackMessageActivity)
    // — only need to know a message happened, not its content, so
    // MessageContent (a privileged intent) is deliberately not requested.
    GatewayIntentBits.GuildMessages,
  ],
  // No DirectMessages intent or channel partials needed — onboarding runs
  // entirely through interactions (buttons, modals) now, not message
  // collectors, and the join-nudge DM is a fire-and-forget send that
  // doesn't need any gateway intent.
});

const onboardingCommand = new SlashCommandBuilder()
  .setName("onboarding")
  .setDescription("Restart GuildThing onboarding from the start")
  .toJSON();

const reactivateCommand = new SlashCommandBuilder()
  .setName("reactivate")
  .setDescription("Restore your roles if you've been marked inactive")
  .toJSON();

// Namespaced under the bot's own name rather than a bare /event — leaves
// room to add more GuildThing-branded commands under the same prefix later
// (/guildthing sync, etc.) without cluttering the top-level command list.
const guildthingCommand = new SlashCommandBuilder()
  .setName("guildthing")
  .setDescription("GuildThing commands")
  .addSubcommand((sub) =>
    sub
      .setName("event")
      .setDescription("Create an event signup (e.g. a dungeon group) here"),
  )
  .toJSON();

// Top-level rather than a /guildthing subcommand — named after the
// OurRecipes addon whose P2P export feeds this lookup (see
// craftLookup.ts's OUR_RECIPES_URL), so the command name matches what
// members already associate the data with.
const ourRecipesCommand = new SlashCommandBuilder()
  .setName("ourrecipes")
  .setDescription(
    "Look up a recipe's reagents, Wowhead link, and who in the guild can make it",
  )
  .addStringOption((opt) =>
    opt
      .setName("item")
      .setDescription("Recipe or enchant name (TBC only for now)")
      .setRequired(true)
      .setAutocomplete(true),
  )
  .toJSON();

// Officer/admin tooling, namespaced under one command so future additions
// land here instead of cluttering the top-level command list. Gated via
// Discord's own default member permissions (ManageGuild) rather than
// GuildAdminRole/createdById, unlike the web app's checkGuildAdmin —
// simplest thing that works here; revisit if a subcommand ever needs the
// exact same admin definition the web app uses.
const bossmanCommand = new SlashCommandBuilder()
  .setName("bossman")
  .setDescription("Admin/officer tools")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName("role-diff")
      .setDescription(
        "Show roster members whose Discord roles don't match the role rules",
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("sync-roster")
      .setDescription(
        "Resync this server's roles/ranks against the roster right now",
      ),
  )
  .toJSON();

// Guild-scoped registration (not global) — applies instantly instead of
// waiting up to an hour for Discord to propagate a global command, which
// matters a lot while actively testing the flow.
async function registerCommands(guild: Guild) {
  try {
    await guild.commands.set([
      onboardingCommand,
      reactivateCommand,
      guildthingCommand,
      ourRecipesCommand,
      bossmanCommand,
    ]);
  } catch (err) {
    console.error(`[bot] failed to register commands for ${guild.name}:`, err);
  }
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(
    `[bot] logged in as ${readyClient.user.tag}, registering commands...`,
  );
  void Promise.all(
    readyClient.guilds.cache.map((g) => registerCommands(g)),
  ).then(() => console.log("[bot] ready — commands registered"));

  // Best-effort mitigation for this host's slow/flaky primary DNS server
  // (a cold discord.com lookup alone can take several seconds — see the
  // README/commit history for the full diagnosis): a real fix needs the
  // host's DNS config changed, which this process can't do for itself, so
  // instead keep a REST connection warm with a cheap, harmless GET every
  // few seconds. This doesn't guarantee every interaction lands on an
  // already-warm connection, but it means most of the time the slow
  // lookup happens here in the background, not inside Discord's 3s
  // interaction-acknowledgement window. Fired immediately too, not just on
  // the first interval tick — otherwise anything run in the first ~10s
  // after startup still hits the cold path, which is exactly when someone
  // testing the bot is most likely to try it.
  const warmRestConnection = () => {
    client.rest.get(Routes.gateway()).catch(() => {
      // Ignore — worst case, the next real request pays the cold-lookup
      // cost, same as if this didn't run at all.
    });
  };
  warmRestConnection();
  setInterval(warmRestConnection, 10_000);

  // Keeps rule-granted roles in sync with the roster over time (level-ups,
  // rank changes) without anyone needing to re-run /onboarding, and retries
  // anyone stuck in the pending-roster-match queue (joined before their
  // name was imported) — see roleSync.ts / pendingMatches.ts for details on
  // why once a day is enough for now.
  const runDailySync = () => {
    runFullRoleSync(readyClient).catch((err: unknown) => {
      console.error("[bot] full role sync failed:", err);
    });
    syncPendingRosterMatches(readyClient).catch((err: unknown) => {
      console.error("[bot] pending roster match sync failed:", err);
    });
    syncExternalCharacters(readyClient).catch((err: unknown) => {
      console.error("[bot] external character sync failed:", err);
    });
    runInactivityFilter(readyClient).catch((err: unknown) => {
      console.error("[bot] inactivity filter failed:", err);
    });
  };
  runDailySync();
  setInterval(runDailySync, ROLE_SYNC_INTERVAL_MS);

  const checkOnboardingButtons = () => {
    ensureOnboardingButtons(readyClient).catch((err: unknown) => {
      console.error("[bot] onboarding button check failed:", err);
    });
  };
  checkOnboardingButtons();
  setInterval(checkOnboardingButtons, ONBOARDING_BUTTON_CHECK_INTERVAL_MS);

  const checkForceSync = () => {
    checkForceSyncRequests(readyClient).catch((err: unknown) => {
      console.error("[bot] force-sync check failed:", err);
    });
  };
  checkForceSync();
  setInterval(checkForceSync, FORCE_SYNC_CHECK_INTERVAL_MS);

  const checkEvents = () => {
    syncPendingWebEvents(readyClient).catch((err: unknown) => {
      console.error("[bot] event web-sync failed:", err);
    });
    runEventExpiry(readyClient).catch((err: unknown) => {
      console.error("[bot] event expiry failed:", err);
    });
    ensureEventCreateButtons(readyClient).catch((err: unknown) => {
      console.error("[bot] event-create button check failed:", err);
    });
  };
  checkEvents();
  setInterval(checkEvents, EVENT_TICK_INTERVAL_MS);

  const checkEventButtonDrift = () => {
    repostDriftedEventButtons(readyClient).catch((err: unknown) => {
      console.error("[bot] event-create button drift check failed:", err);
    });
  };
  checkEventButtonDrift();
  setInterval(checkEventButtonDrift, EVENT_BUTTON_DRIFT_CHECK_INTERVAL_MS);

  const checkDailyButtonRepost = () => {
    repostDailyEventButtons(readyClient).catch((err: unknown) => {
      console.error("[bot] daily event-create button repost failed:", err);
    });
  };
  checkDailyButtonRepost();
  setInterval(checkDailyButtonRepost, DAILY_BUTTON_REPOST_CHECK_INTERVAL_MS);
});

// Runs the same full roster/role/channel-grant sync as the daily job, but
// only when at least one guild has been flagged via the site's "Sync now"
// button — lets an admin get an immediate resync while debugging a
// rule/channel-grant setup instead of waiting up to a day.
async function checkForceSyncRequests(
  client: import("discord.js").Client<true>,
): Promise<void> {
  const pending = await db.guild.findMany({
    where: { forceSyncRequestedAt: { not: null } },
    select: { id: true, botEnabled: true },
  });
  if (pending.length === 0) return;

  console.log(
    `[bot] force-sync requested for ${pending.length} guild(s), syncing now`,
  );
  await runFullRoleSync(client);
  await syncPendingRosterMatches(client);
  // Only clear the flag for guilds that actually got synced — runFullRoleSync/
  // syncPendingRosterMatches skip disabled guilds internally, so a disabled
  // guild's request stays pending and gets picked up once it's re-enabled,
  // instead of silently getting dropped.
  const synced = pending.filter((g) => g.botEnabled);
  if (synced.length > 0) {
    await db.guild.updateMany({
      where: { id: { in: synced.map((g) => g.id) } },
      data: { forceSyncRequestedAt: null },
    });
  }
}

// So /onboarding (and the onboarding button, once its channel is set) work
// right away in a server the bot's newly invited to, without needing a bot
// restart.
client.on(Events.GuildCreate, (guild) => {
  registerCommands(guild).catch((err: unknown) => {
    console.error(`[bot] failed to register commands for ${guild.name}:`, err);
  });
});

// No longer starts the interactive flow itself — that needs a live
// interaction to reply/showModal through (button click or slash command),
// which a raw join event doesn't have. Just a best-effort DM pointing them
// at how to start it; the reliable path is the always-visible onboarding
// button/command on the server itself, not this.
client.on(Events.GuildMemberAdd, (member) => {
  notifyNewMemberToOnboard(member).catch((err: unknown) => {
    console.error(
      `[bot] join notification failed for ${member.user.tag}:`,
      err,
    );
  });
  initializeMemberActivity(member).catch((err: unknown) => {
    console.error(`[bot] activity init failed for ${member.user.tag}:`, err);
  });
});

// No inactivity data worth keeping once someone's gone.
client.on(Events.GuildMemberRemove, (member) => {
  removeMemberActivity(member.guild.id, member.id).catch((err: unknown) => {
    console.error(`[bot] activity cleanup failed for ${member.user.tag}:`, err);
  });
});

client.on(Events.MessageCreate, (message) => {
  trackMessageActivity(message).catch((err: unknown) => {
    console.error("[bot] activity tracking failed:", err);
  });
  scheduleEventButtonRepostOnMessage(message.client, message);
});

client.on(Events.InteractionCreate, (interaction) => {
  if (
    interaction.isChatInputCommand() &&
    interaction.commandName === "reactivate"
  ) {
    void handleReactivate(interaction).catch((err: unknown) => {
      console.error(
        `[bot] /reactivate failed for ${interaction.user.tag}:`,
        err,
      );
    });
    return;
  }

  if (
    interaction.isAutocomplete() &&
    interaction.commandName === "ourrecipes"
  ) {
    void handleCraftAutocomplete(interaction).catch((err: unknown) => {
      console.error(`[bot] /ourrecipes autocomplete failed:`, err);
    });
    return;
  }

  if (
    interaction.isChatInputCommand() &&
    interaction.commandName === "ourrecipes"
  ) {
    void handleCraftCommand(interaction).catch((err: unknown) => {
      console.error(
        `[bot] /ourrecipes failed for ${interaction.user.tag}:`,
        err,
      );
    });
    return;
  }

  if (
    interaction.isChatInputCommand() &&
    interaction.commandName === "bossman" &&
    interaction.options.getSubcommand() === "role-diff"
  ) {
    void handleRoleDiffCommand(interaction).catch((err: unknown) => {
      console.error(
        `[bot] /bossman role-diff failed for ${interaction.user.tag}:`,
        err,
      );
    });
    return;
  }

  if (
    interaction.isChatInputCommand() &&
    interaction.commandName === "bossman" &&
    interaction.options.getSubcommand() === "sync-roster"
  ) {
    void handleSyncRosterCommand(interaction).catch((err: unknown) => {
      console.error(
        `[bot] /bossman sync-roster failed for ${interaction.user.tag}:`,
        err,
      );
    });
    return;
  }

  if (
    interaction.isButton() &&
    interaction.customId.startsWith("craft-share:")
  ) {
    void handleCraftShareButton(interaction).catch((err: unknown) => {
      console.error(
        `[bot] craft share button failed for ${interaction.user.tag}:`,
        err,
      );
    });
    return;
  }

  if (
    interaction.isChatInputCommand() &&
    interaction.commandName === "guildthing" &&
    interaction.options.getSubcommand() === "event"
  ) {
    void handleEventCreateCommand(interaction).catch((err: unknown) => {
      console.error(
        `[bot] /guildthing event failed for ${interaction.user.tag}:`,
        err,
      );
    });
    return;
  }

  if (
    (interaction.isStringSelectMenu() || interaction.isButton()) &&
    interaction.customId.startsWith("event:")
  ) {
    void handleEventComponentInteraction(interaction).catch((err: unknown) => {
      console.error(
        `[bot] event interaction failed for ${interaction.user.tag}:`,
        err,
      );
    });
    return;
  }

  if (
    interaction.isButton() &&
    interaction.customId === EVENT_CREATE_BUTTON_ID
  ) {
    void handleEventCreateCommand(interaction).catch((err: unknown) => {
      console.error(
        `[bot] event-create button failed for ${interaction.user.tag}:`,
        err,
      );
    });
    return;
  }

  const isOnboardingCommand =
    interaction.isChatInputCommand() &&
    interaction.commandName === "onboarding";
  const isOnboardingButton =
    interaction.isButton() &&
    interaction.customId === START_ONBOARDING_BUTTON_ID;
  if (!isOnboardingCommand && !isOnboardingButton) return;

  console.log(
    `[bot] onboarding interaction received (${isOnboardingButton ? "button" : "command"}) — was ${Date.now() - interaction.createdTimestamp}ms old on arrival, gateway ping ${client.ws.ping}ms`,
  );

  // Force-clears any stuck/abandoned session so re-clicking or re-running
  // /onboarding always starts clean, same as before.
  cancelOnboarding(interaction.user.id);

  // A single interaction failing (e.g. Discord expiring it before we reply
  // — "Unknown interaction") must never take the whole bot process down.
  // Node terminates on unhandled rejections by default, and this handler
  // is fire-and-forget from discord.js's perspective, so every await in
  // the whole onboarding flow needs to stay inside this try.
  void runOnboardingInteractive(interaction).catch((err: unknown) => {
    console.error(
      `[bot] onboarding interaction failed for ${interaction.user.tag}:`,
      err,
    );
  });
});

// Last-resort safety net — logs instead of letting an unhandled rejection
// from anywhere (a missed await, a discord.js internal, etc.) kill the
// whole bot process, which Node does by default since v15.
process.on("unhandledRejection", (err) => {
  console.error("[bot] unhandled rejection:", err);
});

void client.login(token);
