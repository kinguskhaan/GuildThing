import Link from "next/link";

import { Sidebar } from "~/app/_components/sidebar";
import { getSession } from "~/server/better-auth/server";

export default async function GuildsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();

  if (!session) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-discord-base text-discord-text">
        <p>You need to log in to view guilds.</p>
        <Link href="/" className="underline">
          Back to home
        </Link>
      </main>
    );
  }

  return (
    <div className="flex min-h-screen bg-discord-base text-discord-text">
      <Sidebar />
      <div className="flex-1">{children}</div>
    </div>
  );
}
