"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { api } from "~/trpc/react";

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
}

interface CurrentGuild {
  id: string;
  name: string;
  iconUrl: string | null;
}

// The sidebar's top "current guild" button, made clickable — opens a
// dropdown to switch between guilds you have access to, plus a "Create new
// guild" entry if you're allowed to (see guild.canCreateGuild).
export function GuildSwitcher({
  currentGuild,
}: {
  currentGuild: CurrentGuild | undefined;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const guilds = api.guild.list.useQuery();
  const canCreateGuild = api.guild.canCreateGuild.useQuery();

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full flex-col items-center gap-2 rounded-lg px-2 py-3 transition hover:bg-discord-elevated"
      >
        <span className="text-sm font-semibold text-discord-text">
          {currentGuild?.name ?? "Select a guild"}
        </span>
        <span className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-full bg-discord-elevated text-sm font-semibold text-discord-text">
          {currentGuild?.iconUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={currentGuild.iconUrl}
              alt=""
              className="h-full w-full object-cover"
            />
          ) : (
            (currentGuild && initials(currentGuild.name)) ?? "?"
          )}
        </span>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-10 mt-1 w-56 rounded-xl bg-discord-elevated p-2 shadow-lg">
          {guilds.isLoading && (
            <span className="block px-2 py-1 text-sm text-discord-text-muted">
              Loading...
            </span>
          )}
          {guilds.data?.length === 0 && (
            <span className="block px-2 py-1 text-sm text-discord-text-muted">
              No guilds yet.
            </span>
          )}
          {guilds.data?.map((g) => (
            <Link
              key={g.id}
              href={`/guilds/${g.id}`}
              onClick={() => setOpen(false)}
              className={`flex items-center gap-2 rounded-lg px-2 py-2 text-sm transition ${
                g.id === currentGuild?.id
                  ? "bg-discord-elevated-hover text-discord-text"
                  : "text-discord-text-muted hover:bg-discord-elevated-hover hover:text-discord-text"
              }`}
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-discord-elevated-hover text-[10px] font-semibold">
                {g.iconUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={g.iconUrl}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : (
                  initials(g.name)
                )}
              </span>
              {g.name}
            </Link>
          ))}

          {canCreateGuild.data && (
            <>
              <div className="my-1 border-t border-black/20" />
              <Link
                href="/guilds"
                onClick={() => setOpen(false)}
                className="block rounded-lg px-2 py-2 text-sm text-discord-text-muted transition hover:bg-discord-elevated-hover hover:text-discord-text"
              >
                + Create new guild
              </Link>
            </>
          )}
        </div>
      )}
    </div>
  );
}
