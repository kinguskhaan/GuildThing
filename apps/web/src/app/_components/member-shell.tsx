"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

import { Sidebar } from "~/app/_components/sidebar";
import { SpaceInvaderGlyph } from "~/app/_components/space-invader";

// Mobile top bar + off-canvas drawer shell around the guild pages. On lg+
// this renders the exact same flex row as before — the top bar is
// lg:hidden and the sidebar falls through as the static w-56 column.
export function MemberShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Tracks the lg breakpoint so the drawer's inert state only applies while
  // the sidebar is actually off-canvas — never on desktop.
  const [isDesktop, setIsDesktop] = useState(true);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const update = () => setIsDesktop(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  // Navigating always closes the drawer, whether by link tap or back button.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen]);

  // Lock the page behind the drawer so background content can't scroll.
  useEffect(() => {
    if (isDesktop) return;
    document.body.style.overflow = drawerOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [drawerOpen, isDesktop]);

  return (
    <div className="bg-discord-base text-discord-text min-h-screen">
      <header className="bg-discord-sidebar sticky top-0 z-30 flex items-center gap-2 border-b border-black/20 px-3 py-2 lg:hidden">
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open navigation"
          aria-expanded={drawerOpen}
          className="hover:bg-discord-elevated-hover text-discord-text-muted hover:text-discord-text flex h-10 w-10 items-center justify-center rounded-lg transition"
        >
          <svg
            aria-hidden="true"
            width="20"
            height="20"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M3 5h14M3 10h14M3 15h14" />
          </svg>
        </button>
        <span className="text-discord-text-muted flex items-center gap-2">
          <SpaceInvaderGlyph className="text-discord-brand h-4 w-4" />
          <span className="font-[family-name:var(--font-arcade-display)] text-sm">
            guildthing
          </span>
        </span>
      </header>

      <div className="flex min-h-screen">
        {/* Scrim sits under the drawer (z-30 < z-40) and above the page. */}
        <button
          type="button"
          aria-label="Close navigation"
          aria-hidden={!drawerOpen}
          tabIndex={-1}
          onClick={() => setDrawerOpen(false)}
          className={`fixed inset-0 z-30 bg-black/60 transition-opacity duration-200 ease-out lg:hidden ${
            drawerOpen ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
        />
        <Sidebar
          mobileOpen={drawerOpen}
          inert={!isDesktop && !drawerOpen ? true : undefined}
        />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
