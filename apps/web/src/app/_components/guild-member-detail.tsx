"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { ConfirmButton } from "~/app/_components/confirm-button";
import { classColor, relativeTime, absoluteTime } from "~/lib/format";
import { api } from "~/trpc/react";
import type { RouterOutputs } from "~/trpc/react";

type Member = RouterOutputs["guild"]["rosterMembers"][number];
type NicknameRow = RouterOutputs["guild"]["memberNicknames"][number];

// The roster table's one drill-down: everything about a claimed Discord
// account in one place — identity, every character they've claimed (not
// just the row that was clicked), and their own slice of the audit log —
// instead of that being scattered across the retired standalone Nicknames
// table, inline table buttons, and a global audit log with no per-person
// entry point.
export function GuildMemberDetail({
  guildId,
  discordUserId,
  allMembers,
  nicknameRow,
  onClose,
}: {
  guildId: string;
  discordUserId: string | null;
  allMembers: Member[];
  nicknameRow: NicknameRow | undefined;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const utils = api.useUtils();
  const [nicknameDraft, setNicknameDraft] = useState("");

  const characters = discordUserId
    ? allMembers.filter((m) => m.claimedByDiscordUserId === discordUserId)
    : [];
  const primary = characters[0];

  useEffect(() => {
    if (discordUserId) {
      setNicknameDraft(nicknameRow?.preferredNickname ?? "");
      dialogRef.current?.showModal();
    } else {
      dialogRef.current?.close();
    }
  }, [discordUserId, nicknameRow]);

  const auditLog = api.guild.auditLog.useQuery(
    { guildId, discordUserId: discordUserId ?? "" },
    { enabled: !!discordUserId },
  );

  const setOverride = api.guild.setMemberNicknameOverride.useMutation({
    onSuccess: async () => {
      await utils.guild.memberNicknames.invalidate({ guildId });
      router.refresh();
    },
  });
  const clearClaim = api.guild.clearRosterClaim.useMutation({
    onSuccess: () => router.refresh(),
  });

  if (!discordUserId || !primary) return null;

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onCancel={onClose}
      className="w-full max-w-lg rounded-xl bg-discord-elevated p-0 text-discord-text backdrop:bg-black/60"
    >
      <div className="flex max-h-[85vh] flex-col">
        <div className="flex items-center justify-between border-b border-black/20 px-6 py-4">
          <div>
            <h3 className="text-lg font-bold">
              {nicknameRow?.preferredNickname ??
                nicknameRow?.computedName ??
                primary.claimedByDiscordTag}
            </h3>
            <p className="text-sm text-discord-text-muted">
              {primary.claimedByDiscordTag}
              {nicknameRow?.currentDiscordNick && (
                <> · Discord nick: {nicknameRow.currentDiscordNick}</>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            className="rounded-full px-2 py-1 text-discord-text-muted hover:bg-discord-elevated-hover hover:text-discord-text"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-5 overflow-y-auto px-6 py-4">
          {nicknameRow && (
            <div className="flex flex-col gap-2">
              <span className="text-xs font-semibold tracking-wide text-discord-text-muted uppercase">
                Nickname override
              </span>
              <p className="text-xs text-discord-text-muted">
                Computed: {nicknameRow.computedName}
              </p>
              <div className="flex items-center gap-2">
                <input
                  className="w-full rounded-full bg-discord-base px-3 py-1.5 text-sm text-discord-text"
                  value={nicknameDraft}
                  onChange={(e) => setNicknameDraft(e.target.value)}
                  placeholder="No override — using computed name"
                />
                <button
                  type="button"
                  onClick={() =>
                    setOverride.mutate({
                      guildId,
                      discordUserId,
                      nickname: nicknameDraft.trim() === "" ? null : nicknameDraft.trim(),
                    })
                  }
                  disabled={setOverride.isPending}
                  className="shrink-0 rounded-full bg-discord-elevated-hover px-3 py-1.5 text-sm font-semibold hover:bg-discord-brand"
                >
                  Save
                </button>
              </div>
              {setOverride.isSuccess && setOverride.data.applied === false && (
                <p className="text-sm text-discord-red">
                  Saved, but couldn&apos;t apply it on Discord — check my role
                  position, or the name may be too long.
                </p>
              )}
            </div>
          )}

          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold tracking-wide text-discord-text-muted uppercase">
              Characters ({characters.length})
            </span>
            <ul className="flex flex-col gap-1.5">
              {characters.map((c) => (
                <li
                  key={c.id}
                  className="flex items-center justify-between gap-2 rounded-lg bg-discord-base px-3 py-2 text-sm"
                >
                  <div>
                    <span className="font-semibold" style={{ color: classColor(c.class) }}>
                      {c.name}
                    </span>{" "}
                    <span className="text-discord-text-muted">
                      {c.rank} · lvl {c.level}
                    </span>
                    {c.officerNote && (
                      <p className="text-xs text-discord-text-muted">
                        Officer note: {c.officerNote}
                      </p>
                    )}
                  </div>
                  <ConfirmButton
                    label="Unclaim"
                    confirmLabel="Unclaim"
                    description={`Un-claim ${c.name} from ${c.claimedByDiscordTag}? They'll need to run /onboarding again (or an admin will need to re-claim it) to link it back.`}
                    onConfirm={() => clearClaim.mutate({ guildId, rosterMemberId: c.id })}
                    disabled={
                      clearClaim.isPending && clearClaim.variables?.rosterMemberId === c.id
                    }
                    className="shrink-0 rounded-full bg-discord-elevated px-2 py-0.5 text-xs hover:bg-discord-elevated-hover"
                  />
                </li>
              ))}
            </ul>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold tracking-wide text-discord-text-muted uppercase">
              Their activity
            </span>
            {!auditLog.data ? (
              <p className="text-sm text-discord-text-muted">Loading…</p>
            ) : auditLog.data.length === 0 ? (
              <p className="text-sm text-discord-text-muted">
                No rank, role, or claim history yet.
              </p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm">
                {auditLog.data.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex items-baseline gap-2 rounded-lg bg-discord-base px-3 py-1.5"
                  >
                    <span
                      className="shrink-0 text-xs text-discord-text-muted"
                      title={absoluteTime(new Date(entry.detectedAt))}
                    >
                      {relativeTime(new Date(entry.detectedAt))}
                    </span>
                    <span className="text-discord-text-muted">
                      {entry.kind === "rank_change"
                        ? `Rank ${entry.oldRank ?? "?"} → ${entry.newRank}`
                        : entry.kind === "claim"
                          ? `Claimed by ${entry.discordUserTag ?? "someone"}`
                          : [
                              entry.addedRoleNames.length > 0
                                ? `+${entry.addedRoleNames.join(", ")}`
                                : "",
                              entry.removedRoleNames.length > 0
                                ? `-${entry.removedRoleNames.join(", ")}`
                                : "",
                            ]
                              .filter(Boolean)
                              .join(" ") +
                            ` by ${entry.source === "bot" ? "the bot" : (entry.executorTag ?? "someone")}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </dialog>
  );
}
