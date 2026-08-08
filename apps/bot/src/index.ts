import { Client, Events, GatewayIntentBits, Partials } from "discord.js";

import { handleNewMember } from "./onboarding.js";

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

client.once(Events.ClientReady, (readyClient) => {
  console.log(`[bot] logged in as ${readyClient.user.tag}`);
});

client.on(Events.GuildMemberAdd, (member) => {
  handleNewMember(member).catch((err: unknown) => {
    console.error(`[bot] onboarding failed for ${member.user.tag}:`, err);
  });
});

void client.login(token);
