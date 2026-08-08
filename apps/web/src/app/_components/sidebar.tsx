"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { authClient } from "~/server/better-auth/client";
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

function navLinkClass(active: boolean) {
  return `rounded-lg px-2 py-2 text-sm transition ${
    active
      ? "bg-discord-elevated-hover text-discord-text"
      : "text-discord-text-muted hover:bg-discord-elevated hover:text-discord-text"
  }`;
}

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();

  const guilds = api.guild.list.useQuery();
  const guild = guilds.data?.[0];

  const guildInfo = api.guild.get.useQuery(
    { guildId: guild?.id ?? "" },
    { enabled: !!guild },
  );
  const hasAccess = guildInfo.data?.viewerHasAccess ?? false;
  const isAdmin = guildInfo.data?.isAdmin ?? false;

  const professions = api.guild.professionsOverview.useQuery(
    { guildId: guild?.id ?? "" },
    { enabled: !!guild && hasAccess },
  );

  const membersHref = guild ? `/guilds/${guild.id}/members` : "";
  const adminLinks = guild
    ? [
        { href: `/guilds/${guild.id}/admin/recipes`, label: "Raw recipe catalog" },
        { href: `/guilds/${guild.id}/admin/data`, label: "Manage imported data" },
      ]
    : [];

  return (
    <nav className="flex h-screen w-56 shrink-0 flex-col gap-1 border-r border-black/20 bg-discord-sidebar p-3">
      {guild && (
        <>
          <Link
            href={`/guilds/${guild.id}`}
            className="flex flex-col items-center gap-2 rounded-lg px-2 py-3 transition hover:bg-discord-elevated"
          >
            <span className="text-sm font-semibold text-discord-text">
              {guild.name}
            </span>
            <span className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-full bg-discord-elevated text-sm font-semibold text-discord-text">
              {guild.iconUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={guild.iconUrl}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : (
                initials(guild.name)
              )}
            </span>
          </Link>

          <div className="my-2 border-t border-black/20" />
        </>
      )}

      {hasAccess && (
        <>
          <Link href={membersHref} className={navLinkClass(pathname === membersHref)}>
            Members
          </Link>

          <div className="my-2 border-t border-black/20" />

          <span className="px-2 pb-2 text-xs font-semibold uppercase tracking-wide text-discord-text-muted">
            Professions
          </span>

          {professions.isLoading && (
            <span className="px-2 text-sm text-discord-text-muted">Loading...</span>
          )}
          {professions.error && (
            <span className="px-2 text-sm text-discord-red">
              {professions.error.message}
            </span>
          )}
          {professions.data?.length === 0 && (
            <span className="px-2 text-sm text-discord-text-muted">
              No professions imported yet.
            </span>
          )}

          {professions.data?.map((profession) => {
            const href = `/guilds/${guild!.id}/${encodeURIComponent(profession.name)}`;
            return (
              <Link
                key={profession.name}
                href={href}
                className={`flex items-center justify-between ${navLinkClass(pathname === href)}`}
              >
                <span>{profession.name}</span>
                <span className="text-xs text-discord-text-muted">
                  {profession.characters.length}
                </span>
              </Link>
            );
          })}
        </>
      )}

      {isAdmin && (
        <>
          <span className="mt-3 px-2 pb-2 text-xs font-semibold uppercase tracking-wide text-discord-text-muted">
            Admin
          </span>
          {adminLinks.map(({ href, label }) => (
            <Link key={href} href={href} className={navLinkClass(pathname === href)}>
              {label}
            </Link>
          ))}
        </>
      )}

      <span className="mt-3 px-2 pb-2 text-xs font-semibold uppercase tracking-wide text-discord-text-muted">
        Addon
      </span>
      <Link href="/guilds/addon" className={navLinkClass(pathname === "/guilds/addon")}>
        Download
      </Link>

      <div className="flex-1" />

      <button
        onClick={() => {
          void authClient.signOut().then(() => {
            router.push("/");
            router.refresh();
          });
        }}
        className={`text-left ${navLinkClass(false)}`}
      >
        Sign out
      </button>
    </nav>
  );
}
