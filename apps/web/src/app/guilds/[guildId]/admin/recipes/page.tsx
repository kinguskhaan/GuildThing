import { notFound } from "next/navigation";

import { AdminRecipeCatalog } from "~/app/_components/admin-recipe-catalog";
import { tbcProfessionRecipes, tbcRecipes } from "@guildthing/wowhead-data";
import { api } from "~/trpc/server";

export default async function AdminRecipesPage({
  params,
}: {
  params: Promise<{ guildId: string }>;
}) {
  const { guildId } = await params;
  const guild = await api.guild.get({ guildId });

  if (!guild.isAdmin) notFound();

  const entries = Object.entries(tbcRecipes);

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <div className="w-full max-w-4xl">
        <h2 className="text-xl font-bold">Raw recipe catalog</h2>
        <a
          href="https://www.wowhead.com/tbc/items/recipes"
          target="_blank"
          rel="noreferrer"
          className="text-sm text-discord-link hover:underline"
        >
          View recipes on Wowhead ↗
        </a>
        <p className="mt-1 text-sm text-discord-text-muted">
          Everything scraped from Wowhead/tbcdb, independent of who in this
          guild can craft it.
        </p>
      </div>
      <AdminRecipeCatalog
        entries={entries}
        professionRecipes={tbcProfessionRecipes}
      />
    </div>
  );
}
