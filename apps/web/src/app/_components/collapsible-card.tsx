"use client";

import type { ReactNode } from "react";

// The one collapse/expand shell every panel on the roster page (and
// elsewhere) should use — a single place to keep the chevron direction,
// header layout, and aria-expanded wiring consistent instead of each panel
// reimplementing its own toggle button.
export function CollapsibleCard({
  title,
  count,
  collapsed,
  onToggle,
  children,
  className = "",
}: {
  title: string;
  count?: number;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex w-full flex-col gap-2 rounded-xl bg-discord-elevated p-4 ${className}`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex items-center justify-between text-left"
      >
        <h3 className="font-bold">
          {title}
          {count !== undefined && ` (${count})`}
        </h3>
        <span aria-hidden="true" className="text-discord-text-muted">
          {collapsed ? "▸" : "▾"}
        </span>
      </button>
      {!collapsed && children}
    </div>
  );
}
