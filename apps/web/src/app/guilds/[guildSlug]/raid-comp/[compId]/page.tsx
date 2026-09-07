import Link from "next/link";
import { notFound } from "next/navigation";

import { RaidCompView } from "~/app/_components/raid-comp-view";
import { expansionDef } from "~/app/_components/raid-comp-state";
import { api } from "~/trpc/server";

// Read-only share view for one saved raid comp — the URL the admin
// builder's "Copy share link" button puts on the clipboard. Reachable by
// any logged-in guild member with the guild's required roles (the layout's
// viewerHasAccess gate + raidComp.view's checkGuildRole), not just
// officers: that's the whole point of sharing the link.
export default async function RaidCompSharePage({
  params,
}: {
  params: Promise<{ guildSlug: string; compId: string }>;
}) {
  const { guildSlug, compId } = await params;
  const { id: guildId } = await api.guild.resolveSlug({ slug: guildSlug });
  const guild = await api.guild.get({ guildId });
  if (!guild.viewerHasAccess) notFound();

  // A compId from another guild (or a deleted one) is just a 404 — no
  // distinction worth surfacing to the link's recipients.
  const comp = await api.raidComp.view({ compId }).catch(() => notFound());
  const expansion = expansionDef(guild.expansion);

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="w-full">
        <h2 className="text-xl font-bold">{comp.name}</h2>
        <p className="text-discord-text-muted mt-1 text-sm">
          Shared raid comp — read-only snapshot.{" "}
          {guild.isAdmin && (
            <Link
              href={`/guilds/${guildSlug}/admin/raid-comp`}
              className="text-discord-link hover:underline"
            >
              Edit in the builder
            </Link>
          )}
        </p>
      </div>
      <RaidCompView expansion={expansion} comp={comp} />
    </div>
  );
}
