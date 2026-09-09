"use client";

import { useEffect, useRef, useState } from "react";

import { api } from "~/trpc/react";

export type ClaimPrefill = {
  discordUserId: string;
  tag: string;
  computedName: string | null;
  preferredNickname: string | null;
} | null;

// Existing roster rows as name suggestions for the character field —
// claimedByTag lets the picker mark rows the backend would refuse to
// re-claim ("Won't take over a claim someone else already holds").
export type RosterNameOption = { name: string; claimedByTag: string | null };

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
  rankOptions,
  classOptions,
  nameOptions,
  onClose,
}: {
  guildId: string;
  open: boolean;
  prefill: ClaimPrefill;
  rankOptions: string[];
  classOptions: string[];
  nameOptions: RosterNameOption[];
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [discordUserId, setDiscordUserId] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [names, setNames] = useState<string[]>([]);
  const [rank, setRank] = useState("");
  const [level, setLevel] = useState("");
  const [charClass, setCharClass] = useState("");
  const [nicknameDraft, setNicknameDraft] = useState("");
  const [results, setResults] = useState<string[] | null>(null);

  useEffect(() => {
    if (!open) {
      dialogRef.current?.close();
      return;
    }
    setDiscordUserId(prefill?.discordUserId ?? "");
    setNicknameDraft(prefill?.preferredNickname ?? "");
    setNameInput("");
    setNames([]);
    setRoleFilter("");
    setRank("");
    setLevel("");
    setCharClass("");
    setResults(null);
    dialogRef.current?.showModal();
  }, [open, prefill]);

  const utils = api.useUtils();
  const members = api.guild.guildMembersForClaim.useQuery(
    { guildId },
    { enabled: open },
  );

  // Role filter narrows the member dropdown; the selected member is
  // always looked up from the full list so their role chips stay visible
  // even if the active filter would hide them.
  const visibleMembers = (members.data?.members ?? []).filter(
    (m) => roleFilter === "" || m.roleIds.includes(roleFilter),
  );
  const selectedMember = members.data?.members.find(
    (m) => m.id === discordUserId,
  );
  const claim = api.guild.adminClaimCharacter.useMutation();
  const setOverride = api.guild.setMemberNicknameOverride.useMutation({
    onSuccess: async () => utils.guild.unclaimedMembers.invalidate({ guildId }),
  });

  function addName() {
    const name = nameInput.trim();
    if (name === "" || names.includes(name)) return;
    setNames([...names, name]);
    setNameInput("");
    setResults(null);
  }

  async function submit() {
    const member = members.data?.members.find((m) => m.id === discordUserId);
    if (!member || names.length === 0) return;
    const out: string[] = [];
    for (const name of names) {
      try {
        const r = await claim.mutateAsync({
          guildId,
          discordUserId: member.id,
          discordUserTag: member.tag,
          name,
          rank: rank === "" ? undefined : rank,
          level: level === "" ? undefined : Number(level),
          class: charClass === "" ? undefined : charClass,
        });
        out.push(
          `${name}: ${r.created ? "created and claimed" : "claimed the existing row"}`,
        );
      } catch (err) {
        out.push(
          `${name}: ${(err as { message?: string }).message ?? "failed"}`,
        );
      }
    }
    setResults(out);
    setNames([]);
    setNameInput("");
    await Promise.all([
      utils.guild.rosterMembers.invalidate({ guildId }),
      utils.guild.unclaimedMembers.invalidate({ guildId }),
      utils.guild.pendingRosterMatches.invalidate({ guildId }),
    ]);
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onCancel={onClose}
      className="bg-discord-elevated text-discord-text w-full max-w-lg rounded-xl p-6 backdrop:bg-black/60"
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold">
            {prefill
              ? `Claim a character for ${prefill.tag}`
              : "Claim a character"}
          </h3>
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            className="text-discord-text-muted hover:bg-discord-elevated-hover hover:text-discord-text rounded-full px-2 py-1"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {prefill?.computedName && (
          <div className="bg-discord-base flex flex-col gap-2 rounded-lg p-3">
            <span className="text-discord-text-muted text-xs font-semibold uppercase tracking-wide">
              Nickname override
            </span>
            <p className="text-discord-text-muted text-xs">
              Computed: {prefill.computedName}
            </p>
            <div className="flex items-center gap-2">
              <input
                className="bg-discord-elevated text-discord-text w-full rounded-full px-3 py-1.5 text-sm"
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
                    nickname:
                      nicknameDraft.trim() === "" ? null : nicknameDraft.trim(),
                  })
                }
                disabled={setOverride.isPending}
                className="bg-discord-elevated-hover hover:bg-discord-brand shrink-0 rounded-full px-3 py-1.5 text-sm font-semibold"
              >
                Save
              </button>
            </div>
          </div>
        )}

        <p className="text-discord-text-muted text-sm">
          Manually claim characters for someone — for an out-of-guild alt
          that&apos;ll never show up in an addon import, or to fix a claim by
          hand. If a name already exists as an unclaimed roster row, it&apos;s
          claimed as-is; otherwise a new row is created (rank/level/class below
          only apply then). Won&apos;t take over a claim someone else already
          holds.
        </p>

        <div className="flex flex-col gap-2">
          <span className="text-discord-text-muted text-xs font-semibold uppercase tracking-wide">
            Discord member
          </span>
          <div className="flex gap-2">
            <MemberPicker
              members={visibleMembers}
              value={discordUserId}
              onSelect={setDiscordUserId}
              disabled={!!prefill || claim.isPending}
            />
            <select
              className="bg-discord-base text-discord-text w-44 shrink-0 rounded-full px-4 py-2"
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value)}
              aria-label="Filter members by Discord role"
            >
              <option value="">All Discord roles</option>
              {(members.data?.roles ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
          {selectedMember && (
            <div className="flex flex-wrap items-center gap-1.5">
              {selectedMember.roleIds.length === 0 ? (
                <p className="text-discord-text-muted text-xs">
                  No Discord roles.
                </p>
              ) : (
                selectedMember.roleIds.map((roleId) => {
                  const role = (members.data?.roles ?? []).find(
                    (r) => r.id === roleId,
                  );
                  if (!role) return null;
                  return (
                    <span
                      key={roleId}
                      className="bg-discord-base rounded-full px-3 py-1 text-xs font-medium"
                      style={
                        role.color !== 0
                          ? { color: `#${role.color.toString(16).padStart(6, "0")}` }
                          : undefined
                      }
                    >
                      {role.name}
                    </span>
                  );
                })
              )}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-discord-text-muted text-xs font-semibold uppercase tracking-wide">
            Characters (one or more)
          </span>
          {names.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {names.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setNames(names.filter((x) => x !== n))}
                  disabled={claim.isPending}
                  title="Remove"
                  className="bg-discord-base text-discord-text hover:bg-discord-red/20 flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium"
                >
                  {n} <span aria-hidden>✕</span>
                </button>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <NameField
              className="flex-1"
              value={nameInput}
              onChange={setNameInput}
              onEnter={addName}
              options={nameOptions}
            />
            <button
              type="button"
              onClick={addName}
              disabled={claim.isPending || nameInput.trim() === ""}
              className="bg-discord-elevated-hover hover:bg-discord-brand shrink-0 rounded-full px-3 py-2 text-sm font-semibold"
            >
              Add
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <select
            className="bg-discord-base text-discord-text flex-1 rounded-full px-4 py-2"
            value={rank}
            onChange={(e) => setRank(e.target.value)}
            disabled={claim.isPending}
          >
            <option value="">Rank if new (default: Member)</option>
            {rankOptions.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <input
            type="number"
            min={1}
            className="bg-discord-base text-discord-text w-24 rounded-full px-4 py-2"
            value={level}
            onChange={(e) => setLevel(e.target.value)}
            placeholder="Level"
            disabled={claim.isPending}
          />
          <select
            className="bg-discord-base text-discord-text flex-1 rounded-full px-4 py-2"
            value={charClass}
            onChange={(e) => setCharClass(e.target.value)}
            disabled={claim.isPending}
          >
            <option value="">Class if new (none)</option>
            {classOptions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          onClick={submit}
          disabled={
            claim.isPending || discordUserId === "" || names.length === 0
          }
          className="bg-discord-brand self-start rounded-full px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {claim.isPending
            ? "Claiming..."
            : `Claim ${names.length || "…"} character${names.length === 1 ? "" : "s"}`}
        </button>
        {results && (
          <div className="flex flex-col gap-1 text-sm">
            {results.map((line) => (
              <p
                key={line}
                className={
                  line.includes(": failed")
                    ? "text-discord-red"
                    : "text-discord-green"
                }
              >
                {line}
              </p>
            ))}
          </div>
        )}
      </div>
    </dialog>
  );
}

// Selection-only combobox over the guild's claimable Discord members —
// the value must be one of the listed members, so the claim can't be
// pointed at a typo'd or nonexistent account. Typing filters (fzf-style
// substring match over server nick AND account tag); Enter or click
// picks. The raw text never becomes the claim target. Rows show the
// member's current server nickname with the account tag in parens —
// nicks drift, the tag is who they actually are.

// Dropdown/input label for a member: server nick first (what the admin
// actually sees in Discord), account tag in parens as the stable identity.
function memberLabel(m: { tag: string; nick: string | null } | null): string {
  if (!m) return "";
  return m.nick ? `${m.nick} (${m.tag})` : m.tag;
}

function MemberPicker({
  members,
  value,
  onSelect,
  disabled,
}: {
  members: { id: string; tag: string; nick: string | null }[] | undefined;
  value: string;
  onSelect: (id: string) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const selected = members?.find((m) => m.id === value) ?? null;
  const q = query.trim().toLowerCase();
  const matches = q
    ? (members ?? []).filter(
        (m) =>
          m.tag.toLowerCase().includes(q) ||
          (m.nick ?? "").toLowerCase().includes(q),
      )
    : (members ?? []);

  return (
    <div className="relative flex-1">
      <input
        className="bg-discord-base text-discord-text placeholder:text-discord-text-muted w-full rounded-full px-4 py-2"
        value={open ? query : memberLabel(selected)}
        placeholder="Which Discord member? Type to filter…"
        disabled={disabled}
        onFocus={() => {
          setQuery("");
          setOpen(true);
        }}
        onBlur={() => setOpen(false)}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          const first = matches[0];
          if (e.key === "Enter" && first) {
            e.preventDefault();
            onSelect(first.id);
            setOpen(false);
          }
          if (e.key === "Escape") setOpen(false);
        }}
      />
      {open && !disabled && (
        <div className="bg-discord-base absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-black/10">
          {matches.map((m) => (
            <button
              key={m.id}
              type="button"
              // mousedown instead of click so the pick lands before the
              // input's blur hides the list.
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(m.id);
                setOpen(false);
              }}
              className="text-discord-text hover:bg-discord-elevated-hover block w-full px-4 py-1.5 text-left text-sm"
            >
              {memberLabel(m)}
            </button>
          ))}
          {matches.length === 0 && (
            <p className="text-discord-text-muted px-4 py-2 text-sm">
              No matching member.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// Free-text input with an fzf-style suggestion list of roster names —
// typing a name that exists fills exactly (no typos), typing anything else
// still creates a new row on submit. Rows already claimed by someone else
// are shown muted and can't be picked — the backend would refuse them.
function NameField({
  className,
  value,
  onChange,
  onEnter,
  options,
}: {
  className: string;
  value: string;
  onChange: (v: string) => void;
  onEnter: () => void;
  options: RosterNameOption[];
}) {
  const [open, setOpen] = useState(false);
  const q = value.trim().toLowerCase();
  const matches = q
    ? options.filter((o) => o.name.toLowerCase().includes(q)).slice(0, 20)
    : [];

  return (
    <div className={`relative ${className}`}>
      <input
        className="bg-discord-base text-discord-text placeholder:text-discord-text-muted w-full rounded-full px-4 py-2"
        value={value}
        placeholder="Character name — type or pick existing"
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onEnter();
          }
          if (e.key === "Escape") setOpen(false);
        }}
      />
      {open && matches.length > 0 && (
        <div className="bg-discord-base absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-black/10">
          {matches.map((o) => {
            const taken = o.claimedByTag != null;
            return (
              <button
                key={o.name}
                type="button"
                disabled={taken}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(o.name);
                  setOpen(false);
                }}
                className={`block w-full px-4 py-1.5 text-left text-sm ${
                  taken
                    ? "text-discord-text-muted cursor-not-allowed"
                    : "text-discord-text hover:bg-discord-elevated-hover"
                }`}
              >
                {o.name}
                {taken && (
                  <span className="text-discord-text-muted">
                    {" "}
                    — claimed by {o.claimedByTag}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
