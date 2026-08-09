import {
  Client,
  Events,
  GatewayIntentBits,
  type Guild,
  Partials,
  Routes,
  SlashCommandBuilder,
} from "discord.js";

import { db } from "@guildthing/db";

import { cancelOnboarding, handleNewMember } from "./onboarding.js";
import { ensureOnboardingButtons, START_ONBOARDING_BUTTON_ID } from "./onboardingButton.js";
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

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  throw new Error("DISCORD_BOT_TOKEN is not set");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
  ],
  // DM channels arrive as partials until fetched — needed to reliably send
  // and collect messages in the onboarding DM.
  partials: [Partials.Channel],
});

const onboardingCommand = new SlashCommandBuilder()
  .setName("onboarding")
  .setDescription("Restart the GuildThing onboarding DM from the start")
  .toJSON();

// Guild-scoped registration (not global) — applies instantly instead of
// waiting up to an hour for Discord to propagate a global command, which
// matters a lot while actively testing the flow.
async function registerCommands(guild: Guild) {
  try {
    await guild.commands.set([onboardingCommand]);
  } catch (err) {
    console.error(`[bot] failed to register commands for ${guild.name}:`, err);
  }
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`[bot] logged in as ${readyClient.user.tag}, registering commands...`);
  void Promise.all(readyClient.guilds.cache.map((g) => registerCommands(g))).then(
    () => console.log("[bot] ready — commands registered"),
  );

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
});

// Runs the same full roster/role/channel-grant sync as the daily job, but
// only when at least one guild has been flagged via the site's "Sync now"
// button — lets an admin get an immediate resync while debugging a
// rule/channel-grant setup instead of waiting up to a day.
async function checkForceSyncRequests(client: import("discord.js").Client<true>): Promise<void> {
  const pending = await db.guild.findMany({
    where: { forceSyncRequestedAt: { not: null } },
    select: { id: true },
  });
  if (pending.length === 0) return;

  console.log(`[bot] force-sync requested for ${pending.length} guild(s), syncing now`);
  await runFullRoleSync(client);
  await syncPendingRosterMatches(client);
  await db.guild.updateMany({
    where: { id: { in: pending.map((g) => g.id) } },
    data: { forceSyncRequestedAt: null },
  });
}

// So /onboarding (and the onboarding button, once its channel is set) work
// right away in a server the bot's newly invited to, without needing a bot
// restart.
client.on(Events.GuildCreate, (guild) => {
  registerCommands(guild).catch((err: unknown) => {
    console.error(`[bot] failed to register commands for ${guild.name}:`, err);
  });
});

client.on(Events.GuildMemberAdd, (member) => {
  handleNewMember(member).catch((err: unknown) => {
    console.error(`[bot] onboarding failed for ${member.user.tag}:`, err);
  });
});

// Shared by the /onboarding slash command and the "Start Onboarding"
// button — both just need to ack the interaction and (re)start the DM flow
// for whoever triggered it.
async function startOnboardingFromInteraction(
  interaction:
    | import("discord.js").ChatInputCommandInteraction
    | import("discord.js").ButtonInteraction,
): Promise<void> {
  if (!interaction.guild) return;
  const guild = interaction.guild;

  const replyStarted = Date.now();
  await interaction.reply({
    content: "Check your DMs!",
    flags: ["Ephemeral"],
  });
  console.log(`[bot] interaction.reply() took ${Date.now() - replyStarted}ms`);
  const member = await guild.members.fetch(interaction.user.id);
  cancelOnboarding(member.id);
  await handleNewMember(member).catch((err: unknown) => {
    console.error(`[bot] onboarding failed for ${member.user.tag}:`, err);
  });
}

client.on(Events.InteractionCreate, (interaction) => {
  const isOnboardingCommand =
    interaction.isChatInputCommand() && interaction.commandName === "onboarding";
  const isOnboardingButton =
    interaction.isButton() && interaction.customId === START_ONBOARDING_BUTTON_ID;
  if (!isOnboardingCommand && !isOnboardingButton) return;

  console.log(
    `[bot] onboarding interaction received (${isOnboardingButton ? "button" : "command"}) — was ${Date.now() - interaction.createdTimestamp}ms old on arrival, gateway ping ${client.ws.ping}ms`,
  );

  // A single interaction failing (e.g. Discord expiring it before we reply
  // — "Unknown interaction") must never take the whole bot process down.
  // Node terminates on unhandled rejections by default, and this handler
  // is fire-and-forget from discord.js's perspective, so every await here
  // needs to stay inside this try.
  void startOnboardingFromInteraction(interaction).catch((err: unknown) => {
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
