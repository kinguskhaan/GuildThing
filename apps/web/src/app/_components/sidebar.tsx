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

  const instanceSettings = api.instanceSettings.get.useQuery();
  const isInstanceOwner = instanceSettings.data?.isOwner ?? false;

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

  // "Members" and "Roster" used to be separate pages (self-entered
  // characters/professions vs. the addon-scanned roster) — merged onto one
  // page at /roster, labeled "Members" since that's the more meaningful
  // name for what it shows now.
  const membersHref = guild ? `/guilds/${guild.id}/roster` : "";
  const eventsHref = guild ? `/guilds/${guild.id}/events` : "";
  const adminLinks = guild
    ? [
        {
          href: `/guilds/${guild.id}/admin/recipes`,
          label: "Raw recipe catalog",
        },
        {
          href: `/guilds/${guild.id}/admin/data`,
          label: "Manage imported data",
        },
        {
          href: `/guilds/${guild.id}/admin/discord-roles`,
          label: "Discord onboarding roles",
        },
      ]
    : [];

  return (
    <nav className="bg-discord-sidebar flex h-screen w-56 shrink-0 flex-col gap-1 border-r border-black/20 p-3">
      <GuildSwitcher currentGuild={guild} />
      <div className="my-2 border-t border-black/20" />

      {hasAccess && (
        <>
          <Link
            href={membersHref}
            className={navLinkClass(pathname === membersHref)}
          >
            Members
          </Link>
          <Link
            href={eventsHref}
            className={navLinkClass(pathname === eventsHref)}
          >
            Events
          </Link>

          <div className="my-2 border-t border-black/20" />

          <span className="text-discord-text-muted px-2 pb-2 text-xs font-semibold uppercase tracking-wide">
            Professions
          </span>

          {professions.isLoading && (
            <span className="text-discord-text-muted px-2 text-sm">
              Loading...
            </span>
          )}
          {professions.error && (
            <span className="text-discord-red px-2 text-sm">
              {professions.error.message}
            </span>
          )}
          {professions.data?.length === 0 && (
            <span className="text-discord-text-muted px-2 text-sm">
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
                <span className="text-discord-text-muted text-xs">
                  {profession.characters.length}
                </span>
              </Link>
            );
          })}
        </>
      )}

      {isAdmin && (
        <>
          <span className="text-discord-text-muted mt-3 px-2 pb-2 text-xs font-semibold uppercase tracking-wide">
            Admin
          </span>
          {adminLinks.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              className={navLinkClass(pathname === href)}
            >
              {label}
            </Link>
          ))}
        </>
      )}

      <span className="text-discord-text-muted mt-3 px-2 pb-2 text-xs font-semibold uppercase tracking-wide">
        Addon
      </span>
      <Link
        href="/guilds/addon"
        className={navLinkClass(pathname === "/guilds/addon")}
      >
        Download
      </Link>

      <span className="text-discord-text-muted mt-3 px-2 pb-2 text-xs font-semibold uppercase tracking-wide">
        Bot
      </span>
      <Link
        href="/guilds/bot"
        className={navLinkClass(pathname === "/guilds/bot")}
      >
        Add to Discord
      </Link>

      {isInstanceOwner && (
        <>
          <span className="text-discord-text-muted mt-3 px-2 pb-2 text-xs font-semibold uppercase tracking-wide">
            Instance
          </span>
          <Link
            href="/guilds/settings"
            className={navLinkClass(pathname === "/guilds/settings")}
          >
            Settings
          </Link>
        </>
      )}

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
