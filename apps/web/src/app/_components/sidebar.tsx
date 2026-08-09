"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { GuildSwitcher } from "~/app/_components/guild-switcher";
import { authClient } from "~/server/better-auth/client";
import { api } from "~/trpc/react";

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

  // Which guild's panel to show — derived from the URL (/guilds/{id}/...),
  // not just "the first one", now that an account can have several. On the
  // bare /guilds list (no id in the path) this is undefined and the
  // per-guild sections below are hidden, since there's no single guild to
  // show them for.
  const currentGuildId = /^\/guilds\/([^/]+)/.exec(pathname)?.[1];

  const guilds = api.guild.list.useQuery();
  const guild = guilds.data?.find((g) => g.id === currentGuildId);

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
  const rosterHref = guild ? `/guilds/${guild.id}/roster` : "";
  const adminLinks = guild
    ? [
        { href: `/guilds/${guild.id}/admin/recipes`, label: "Raw recipe catalog" },
        { href: `/guilds/${guild.id}/admin/data`, label: "Manage imported data" },
        { href: `/guilds/${guild.id}/admin/discord-roles`, label: "Discord onboarding roles" },
      ]
    : [];

  return (
    <nav className="flex h-screen w-56 shrink-0 flex-col gap-1 border-r border-black/20 bg-discord-sidebar p-3">
      <GuildSwitcher currentGuild={guild} />
      <div className="my-2 border-t border-black/20" />

      {hasAccess && (
        <>
          <Link href={membersHref} className={navLinkClass(pathname === membersHref)}>
            Members
          </Link>
          <Link href={rosterHref} className={navLinkClass(pathname === rosterHref)}>
            Roster
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

      <span className="mt-3 px-2 pb-2 text-xs font-semibold uppercase tracking-wide text-discord-text-muted">
        Bot
      </span>
      <Link href="/guilds/bot" className={navLinkClass(pathname === "/guilds/bot")}>
        Add to Discord
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
