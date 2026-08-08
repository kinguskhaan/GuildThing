import { redirect } from "next/navigation";

import { CreateGuildForm } from "~/app/_components/create-guild-form";
import { api } from "~/trpc/server";

export default async function GuildsPage() {
  const guilds = await api.guild.list();
  const guild = guilds[0];
  if (guild) {
    redirect(`/guilds/${guild.id}`);
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-10 px-4 py-16">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-4xl font-extrabold tracking-tight">
          Set up your guild
        </h1>
        <p className="max-w-md text-discord-text-muted">
          This instance doesn&apos;t have a guild page yet — create one to get
          started.
        </p>
      </div>
      <CreateGuildForm />
    </main>
  );
}
