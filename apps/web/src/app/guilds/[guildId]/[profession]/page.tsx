import { ProfessionRecipeBrowser } from "~/app/_components/profession-recipe-browser";

export default async function ProfessionPage({
  params,
}: {
  params: Promise<{ guildId: string; profession: string }>;
}) {
  const { guildId, profession } = await params;

  return (
    <div className="flex w-full max-w-4xl flex-col gap-6">
      <h2 className="text-center text-2xl font-bold">{profession}</h2>
      <ProfessionRecipeBrowser guildId={guildId} professionName={profession} />
    </div>
  );
}
