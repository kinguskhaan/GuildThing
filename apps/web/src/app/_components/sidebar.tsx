"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";

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

// Section title — bolder and higher-contrast than a regular nav link so the
// sidebar reads as distinct groups instead of one long flat list.
function SidebarHeading({ children }: { children: ReactNode }) {
  return (
    <span className="text-discord-text px-2 pb-1 text-xs font-bold tracking-wider uppercase">
      {children}
    </span>
  );
}

// One consistent divider between every section, instead of some sections
// getting a line and others just getting margin.
function SidebarDivider() {
  return <div className="my-3 border-t border-black/20" />;
}

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();

  // Which guild's panel to show — derived from the URL (/guilds/{slug}/...),
  // not just "the first one", now that an account can have several. On the
  // bare /guilds list (no slug in the path) this is undefined and the
  // per-guild sections below are hidden, since there's no single guild to
  // show them for.
  const currentGuildSlug = /^\/guilds\/([^/]+)/.exec(pathname)?.[1];

  const instanceSettings = api.instanceSettings.get.useQuery();
  const isInstanceOwner = instanceSettings.data?.isOwner ?? false;

  const guilds = api.guild.list.useQuery();
  const guild = guilds.data?.find((g) => g.slug === currentGuildSlug);

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
  const membersHref = guild ? `/guilds/${guild.slug}/roster` : "";
  const eventsHref = guild ? `/guilds/${guild.slug}/events` : "";
  const adminLinks = guild
    ? [
        {
          href: `/guilds/${guild.slug}/admin/settings`,
          label: "Guild settings",
        },
        {
          href: `/guilds/${guild.slug}/admin/recipes`,
          label: "Raw recipe catalog",
        },
        {
          href: `/guilds/${guild.slug}/admin/data`,
          label: "Manage imported data",
        },
        {
          href: `/guilds/${guild.slug}/admin/discord-roles`,
          label: "Discord onboarding roles",
        },
      ]
    : [];

  return (
    <nav className="bg-discord-sidebar flex h-screen w-56 shrink-0 flex-col gap-1 overflow-y-auto border-r border-black/20 p-3">
      <GuildSwitcher currentGuild={guild} />

      {hasAccess && (
        <>
          <SidebarDivider />

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

          <SidebarDivider />

          <SidebarHeading>Professions</SidebarHeading>

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
            const href = `/guilds/${guild!.slug}/${encodeURIComponent(profession.name)}`;
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
          <SidebarDivider />
          <SidebarHeading>Admin</SidebarHeading>
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

      <SidebarDivider />
      <SidebarHeading>Resources</SidebarHeading>
      <Link
        href="/guilds/addon"
        className={navLinkClass(pathname === "/guilds/addon")}
      >
        Download addon
      </Link>
      <Link
        href="/guilds/bot"
        className={navLinkClass(pathname === "/guilds/bot")}
      >
        Add bot to Discord
      </Link>

      {isInstanceOwner && (
        <>
          <SidebarDivider />
          <SidebarHeading>Instance</SidebarHeading>
          <Link
            href="/guilds/settings"
            className={navLinkClass(pathname === "/guilds/settings")}
          >
            Settings
          </Link>
        </>
      )}

      <div className="flex-1" />
      <SidebarDivider />

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
