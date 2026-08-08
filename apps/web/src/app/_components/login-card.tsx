"use client";

import { FaDiscord } from "react-icons/fa";

import { ParticlesBackground } from "~/app/_components/particles-background";

export function LoginCard({ signIn }: { signIn: () => Promise<void> }) {
  return (
    <div className="relative flex min-h-screen w-full items-center justify-center p-4">
      <ParticlesBackground />
      <div className="relative z-10 flex w-full max-w-sm flex-col items-center gap-2 rounded-lg bg-discord-base/90 p-8 shadow-2xl backdrop-blur-sm">
        <div className="mb-2 flex h-16 w-16 items-center justify-center rounded-full bg-discord-rail">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/assets/space-invader-1.svg"
            alt=""
            className="h-10 w-10"
            style={{
              filter:
                "brightness(0) saturate(100%) invert(91%) sepia(26%) saturate(1464%) hue-rotate(285deg) brightness(98%) contrast(91%)",
            }}
          />
        </div>
        <h1 className="m-0 text-2xl font-bold text-discord-text">
          guildthing
        </h1>
        <p className="m-0 mb-4 text-center text-sm text-discord-text-muted">
          See which crafters your guild has, and what they can make.
        </p>
        <form action={signIn} className="w-full">
          <button
            type="submit"
            className="flex w-full cursor-pointer items-center justify-center gap-2 rounded bg-discord-brand py-3 font-semibold text-discord-text transition hover:bg-discord-brand-hover"
          >
            <FaDiscord size={20} />
            Log in with Discord
          </button>
        </form>
      </div>
    </div>
  );
}
