"use client";

import { useEffect, useRef, useState } from "react";

import { api } from "~/trpc/react";

export type ClaimPrefill = {
  discordUserId: string;
  tag: string;
  computedName: string | null;
  preferredNickname: string | null;
} | null;

// Admin counterpart to onboarding's own name-matching, for what it can't
// handle on its own: an out-of-guild alt (never shows up in an addon
// export, so onboarding can only wait forever) or fixing up a claim by
// hand. If the name already exists as an unclaimed roster row, this just
// claims it as-is; otherwise it creates a new row (rank/level/class only
// matter for that "new character" case — ignored if the row already
// exists). Triggered from the roster table's own "Unclaimed" rows (or a
// blank "+ Claim manually" entry point) rather than sitting as its own
// permanently-visible card.
export function GuildClaimCharacter({
  guildId,
  open,
  prefill,
  onClose,
}: {
  guildId: string;
  open: boolean;
  prefill: ClaimPrefill;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [discordUserId, setDiscordUserId] = useState("");
  const [name, setName] = useState("");
  const [rank, setRank] = useState("");
  const [level, setLevel] = useState("");
  const [charClass, setCharClass] = useState("");
  const [nicknameDraft, setNicknameDraft] = useState("");

  useEffect(() => {
    if (!open) {
      dialogRef.current?.close();
      return;
    }
    setDiscordUserId(prefill?.discordUserId ?? "");
    setNicknameDraft(prefill?.preferredNickname ?? "");
    dialogRef.current?.showModal();
  }, [open, prefill]);

  const utils = api.useUtils();
  const members = api.guild.guildMembersForClaim.useQuery(
    { guildId },
    { enabled: open },
  );
  const classOptions = api.guild.rosterClassOptions.useQuery(
    { guildId },
    { enabled: open },
  );
  const claim = api.guild.adminClaimCharacter.useMutation({
    onSuccess: async () => {
      setName("");
      setRank("");
      setLevel("");
      setCharClass("");
      await Promise.all([
        utils.guild.rosterMembers.invalidate({ guildId }),
        utils.guild.unclaimedMembers.invalidate({ guildId }),
        utils.guild.pendingRosterMatches.invalidate({ guildId }),
      ]);
    },
  });
  const setOverride = api.guild.setMemberNicknameOverride.useMutation({
    onSuccess: async () => utils.guild.unclaimedMembers.invalidate({ guildId }),
  });

  function submit() {
    const member = members.data?.find((m) => m.id === discordUserId);
    if (!member || name.trim() === "") return;
    claim.mutate({
      guildId,
      discordUserId: member.id,
      discordUserTag: member.tag,
      name: name.trim(),
      rank: rank.trim() === "" ? undefined : rank.trim(),
      level: level.trim() === "" ? undefined : Number(level),
      class: charClass.trim() === "" ? undefined : charClass.trim(),
    });
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onCancel={onClose}
      className="w-full max-w-lg rounded-xl bg-discord-elevated p-6 text-discord-text backdrop:bg-black/60"
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold">
            {prefill ? `Claim a character for ${prefill.tag}` : "Claim a character"}
          </h3>
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            className="rounded-full px-2 py-1 text-discord-text-muted hover:bg-discord-elevated-hover hover:text-discord-text"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {prefill?.computedName && (
          <div className="flex flex-col gap-2 rounded-lg bg-discord-base p-3">
            <span className="text-xs font-semibold tracking-wide text-discord-text-muted uppercase">
              Nickname override
            </span>
            <p className="text-xs text-discord-text-muted">
              Computed: {prefill.computedName}
            </p>
            <div className="flex items-center gap-2">
              <input
                className="w-full rounded-full bg-discord-elevated px-3 py-1.5 text-sm text-discord-text"
                value={nicknameDraft}
                onChange={(e) => setNicknameDraft(e.target.value)}
                placeholder="No override — using computed name"
              />
              <button
                type="button"
                onClick={() =>
                  setOverride.mutate({
                    guildId,
                    discordUserId: prefill.discordUserId,
                    nickname: nicknameDraft.trim() === "" ? null : nicknameDraft.trim(),
                  })
                }
                disabled={setOverride.isPending}
                className="shrink-0 rounded-full bg-discord-elevated-hover px-3 py-1.5 text-sm font-semibold hover:bg-discord-brand"
              >
                Save
              </button>
            </div>
          </div>
        )}

        <p className="text-sm text-discord-text-muted">
          Manually claim a character for someone — for an out-of-guild alt
          that&apos;ll never show up in an addon import, or to fix a claim by
          hand. If the name already exists as an unclaimed roster row, it&apos;s
          claimed as-is; otherwise a new row is created (rank/level/class
          below only apply then). Won&apos;t take over a claim someone else
          already holds.
        </p>
        <div className="flex flex-wrap gap-2">
          <select
            className="flex-1 rounded-full bg-discord-base px-4 py-2 text-discord-text"
            value={discordUserId}
            onChange={(e) => setDiscordUserId(e.target.value)}
            disabled={!!prefill}
          >
            <option value="">Which Discord member?</option>
            {members.data?.map((m) => (
              <option key={m.id} value={m.id}>
                {m.tag}
              </option>
            ))}
          </select>
          <input
            className="flex-1 rounded-full bg-discord-base px-4 py-2 text-discord-text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Exact character name"
            autoFocus
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            className="w-32 rounded-full bg-discord-base px-4 py-2 text-discord-text"
            value={rank}
            onChange={(e) => setRank(e.target.value)}
            placeholder="Rank (if new)"
          />
          <input
            type="number"
            className="w-24 rounded-full bg-discord-base px-4 py-2 text-discord-text"
            value={level}
            onChange={(e) => setLevel(e.target.value)}
            placeholder="Level"
          />
          <input
            className="w-40 rounded-full bg-discord-base px-4 py-2 text-discord-text"
            list="claim-class-options"
            value={charClass}
            onChange={(e) => setCharClass(e.target.value)}
            placeholder="Class (if new)"
          />
        </div>
        <button
          type="button"
          onClick={submit}
          disabled={claim.isPending || discordUserId === "" || name.trim() === ""}
          className="self-start rounded-full bg-discord-brand px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {claim.isPending ? "Claiming..." : "Claim"}
        </button>
        {claim.error && <p className="text-sm text-discord-red">{claim.error.message}</p>}
        {claim.isSuccess && (
          <p className="text-sm text-discord-green">
            {claim.data.created ? "Created and claimed." : "Claimed the existing roster row."}
          </p>
        )}
        <datalist id="claim-class-options">
          {classOptions.data?.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </div>
    </dialog>
  );
}
