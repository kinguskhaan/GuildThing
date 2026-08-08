import { notFound } from "next/navigation";

import { AdminDataManager } from "~/app/_components/admin-data-manager";
import { api } from "~/trpc/server";

export default async function AdminDataPage({
  params,
}: {
  params: Promise<{ guildId: string }>;
}) {
  const { guildId } = await params;
  const guild = await api.guild.get({ guildId });

  if (!guild.isAdmin) notFound();

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <div className="w-full max-w-2xl">
        <h2 className="text-xl font-bold">Manage imported data</h2>
        <p className="mt-1 text-sm text-discord-text-muted">
          Remove stray or mistaken characters, professions, and recipes from
          anyone in this guild.
        </p>
      </div>
      <AdminDataManager guildId={guildId} />
    </div>
  );
}
