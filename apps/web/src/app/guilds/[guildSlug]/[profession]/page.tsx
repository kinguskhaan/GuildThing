import { ProfessionRecipeBrowser } from "~/app/_components/profession-recipe-browser";
import { api } from "~/trpc/server";

export default async function ProfessionPage({
  params,
}: {
  params: Promise<{ guildSlug: string; profession: string }>;
}) {
  const { guildSlug, profession } = await params;
  const { id: guildId } = await api.guild.resolveSlug({ slug: guildSlug });

  return (
    <div className="flex w-full max-w-4xl flex-col gap-6">
      <h2 className="text-center text-2xl font-bold">{profession}</h2>
      <ProfessionRecipeBrowser guildId={guildId} professionName={profession} />
    </div>
  );
}
