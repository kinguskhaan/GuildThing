import { GuildEventChannelPresets } from "~/app/_components/guild-event-channel-presets";
import { GuildEventsForm } from "~/app/_components/guild-events-form";
import { GuildEventsList } from "~/app/_components/guild-events-list";
import { api } from "~/trpc/server";

export default async function EventsPage({
  params,
}: {
  params: Promise<{ guildId: string }>;
}) {
  const { guildId } = await params;
  const [guild, events] = await Promise.all([
    api.guild.get({ guildId }),
    api.event.list({ guildId }),
  ]);

  return (
    <div className="flex w-full max-w-3xl flex-col gap-4">
      <h2 className="text-center text-2xl font-bold">Events</h2>

      {guild.isAdmin && <GuildEventsForm guildId={guildId} />}
      {guild.isAdmin && <GuildEventChannelPresets guildId={guildId} />}

      {events.length === 0 ? (
        <div className="bg-discord-elevated text-discord-text-muted w-full rounded-xl p-6 text-center">
          No events yet — create one with the form above, or run{" "}
          <code>/guildthing event</code> in Discord.
        </div>
      ) : (
        <GuildEventsList
          guildId={guildId}
          events={events}
          isAdmin={guild.isAdmin}
        />
      )}
    </div>
  );
}
