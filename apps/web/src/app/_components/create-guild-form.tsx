"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { RoleChipGroup, toggleRoleId } from "~/app/_components/role-chip-picker";
import { api } from "~/trpc/react";

// Manage Nicknames (0x08000000) + Manage Roles (0x10000000) +
// Manage Channels (0x00000010) — same permission set as the post-creation
// /bot page's invite link (kept in sync with that page's BOT_PERMISSIONS
// comment; the bot's own role still needs dragging above what it manages,
// which Discord makes you do by hand after inviting it).
const BOT_PERMISSIONS = 402653200;

type CreatedGuild = {
  id: string;
  slug: string;
  name: string;
  discordGuildId: string;
};

/** One-shot mount transition — translate + fade, matching the landing's
 * scroll Reveal but firing on mount instead of on scroll-into-view, since
 * wizard steps swap in place rather than scrolling past. */
function StepReveal({ children }: { children: React.ReactNode }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setVisible(true);
      return;
    }
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div
      className={`transition-all duration-700 ease-out ${
        visible ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0"
      }`}
    >
      {children}
    </div>
  );
}

function StepKicker({ step }: { step: 1 | 2 | 3 }) {
  return <span className="schem-kicker">Step {step} of 3</span>;
}

/** Step 1: name + which Discord server this guild page is for. Creates the
 * guild immediately on submit (with no roles yet — see requiredRoleIds'
 * default([]) on the create mutation) so the user always lands on a real
 * guild page even if they bail out of steps 2–3. */
function NameAndServerStep({
  onCreated,
}: {
  onCreated: (guild: CreatedGuild) => void;
}) {
  const [name, setName] = useState("");
  const [discordGuildId, setDiscordGuildId] = useState("");
  const [manualEntry, setManualEntry] = useState(false);

  const servers = api.guild.myDiscordServers.useQuery();
  const showPicker = !manualEntry && (servers.data?.length ?? 0) > 0;

  const createGuild = api.guild.create.useMutation({
    onSuccess: (guild) =>
      onCreated({
        id: guild.id,
        slug: guild.slug,
        name: guild.name,
        discordGuildId: guild.discordGuildId,
      }),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        createGuild.mutate({ name, discordGuildId, requiredRoleIds: [], adminRoleIds: [] });
      }}
      className="flex w-full flex-col gap-3"
    >
      <StepKicker step={1} />
      <h2 className="text-xl font-bold">Create a guild page</h2>
      <label className="flex flex-col gap-1 text-sm">
        Name
        <input
          className="rounded-full bg-discord-elevated px-4 py-2 text-discord-text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Insert cool guild name here"
          required
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Discord server
        {showPicker ? (
          <select
            className="rounded-full bg-discord-elevated px-4 py-2 text-discord-text"
            value={discordGuildId}
            onChange={(e) => {
              setDiscordGuildId(e.target.value);
              if (!name) {
                const picked = servers.data?.find((s) => s.id === e.target.value);
                if (picked) setName(picked.name);
              }
            }}
            required
          >
            <option value="">Select a server...</option>
            {servers.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="rounded-full bg-discord-elevated px-4 py-2 text-discord-text"
            value={discordGuildId}
            onChange={(e) => setDiscordGuildId(e.target.value)}
            placeholder="Server ID (copy it in Discord with Developer Mode)"
            required
          />
        )}
        {(servers.data?.length ?? 0) > 0 && (
          <button
            type="button"
            onClick={() => setManualEntry((v) => !v)}
            className="self-start text-xs text-discord-text-muted underline hover:text-discord-text"
          >
            {manualEntry ? "Pick from my servers instead" : "Enter server ID manually instead"}
          </button>
        )}
      </label>
      <p className="text-xs text-discord-text-muted">
        You&apos;ll add the bot and pick access roles in the next two steps —
        nothing to copy by hand here.
      </p>
      {createGuild.error && (
        <p className="text-sm text-discord-red">{createGuild.error.message}</p>
      )}
      <button
        type="submit"
        className="rounded-full bg-discord-brand px-6 py-2 font-semibold text-white transition hover:bg-discord-brand-hover disabled:opacity-50"
        disabled={createGuild.isPending}
      >
        {createGuild.isPending ? "Creating..." : "Continue"}
      </button>
    </form>
  );
}

/** Step 2: invite the bot, then confirm it actually joined — reusing the
 * same bot-token call the admin forms use for the guild's role list
 * (isBotInGuild) rather than trusting a "yes I did it" checkbox. Polls every
 * 4s while waiting and auto-advances the moment it sees the bot. */
function AddBotStep({
  guild,
  discordClientId,
  onConfirmed,
  onSkip,
}: {
  guild: CreatedGuild;
  discordClientId: string;
  onConfirmed: () => void;
  onSkip: () => void;
}) {
  const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${discordClientId}&scope=bot&permissions=${BOT_PERMISSIONS}&guild_id=${guild.discordGuildId}`;

  const botCheck = api.guild.checkBotPresence.useQuery(
    { guildId: guild.id },
    { refetchInterval: 4000 },
  );

  useEffect(() => {
    if (botCheck.data === true) onConfirmed();
  }, [botCheck.data, onConfirmed]);

  return (
    <div className="flex w-full flex-col gap-3">
      <StepKicker step={2} />
      <h2 className="text-xl font-bold">Add the bot to {guild.name}</h2>
      <p className="text-sm text-discord-text-muted">
        The bot reads your server&apos;s roles by name, so the next step can
        offer a pick-list instead of pasted IDs.
      </p>

      <a
        href={inviteUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="self-start rounded-full bg-discord-brand px-6 py-2 font-semibold text-white no-underline transition hover:bg-discord-brand-hover"
      >
        Add to Discord server
      </a>

      <div className="flex items-center gap-2 rounded-lg bg-discord-elevated px-4 py-3">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${
            botCheck.data === true ? "bg-discord-green" : "bg-discord-text-muted"
          }`}
        />
        <span className="schem-mono text-xs text-discord-text-muted">
          {botCheck.data === true
            ? "Bot confirmed — moving on..."
            : "Waiting for the bot to join this server..."}
        </span>
        <button
          type="button"
          onClick={() => botCheck.refetch()}
          className="ml-auto rounded-full bg-discord-elevated-hover px-3 py-1 text-xs font-semibold hover:bg-discord-brand"
        >
          Check again
        </button>
      </div>

      <p className="text-xs text-discord-text-muted">
        Once it&apos;s in, drag the bot&apos;s own role above any role you
        want it to be able to assign, in Server Settings → Roles.
      </p>

      <button
        type="button"
        onClick={onSkip}
        className="self-start text-xs text-discord-text-muted underline hover:text-discord-text"
      >
        Skip for now — I&apos;ll finish setup later
      </button>
    </div>
  );
}

/** Step 3: name-based role picker fed by the bot's own view of the server
 * (api.guild.discordRoles, the same query the Discord Server Controls admin
 * page uses) — no raw IDs. Finishing here calls guild.update, which still
 * requires at least one required role; leaving both empty just means
 * "skip for now," and the guild stays creator-only until settings are
 * revisited (the guild layout's setup banner nudges that). */
function PickRolesStep({
  guild,
  onDone,
}: {
  guild: CreatedGuild;
  onDone: () => void;
}) {
  const [requiredRoleIds, setRequiredRoleIds] = useState<string[]>([]);
  const [adminRoleIds, setAdminRoleIds] = useState<string[]>([]);

  const roles = api.guild.discordRoles.useQuery({ guildId: guild.id });

  const saveRoles = api.guild.update.useMutation({ onSuccess: onDone });

  return (
    <div className="flex w-full flex-col gap-4">
      <StepKicker step={3} />
      <h2 className="text-xl font-bold">Pick your roles</h2>
      <p className="text-sm text-discord-text-muted">
        Anyone holding one of the roles you pick below will be able to open
        this guild page. You always have access as its creator, regardless.
      </p>

      {roles.isLoading ? (
        <p className="text-sm text-discord-text-muted">Loading roles from Discord...</p>
      ) : (roles.data?.length ?? 0) === 0 ? (
        <div className="flex flex-col items-start gap-2 rounded-lg bg-discord-elevated px-4 py-3">
          <p className="text-sm text-discord-text-muted">
            No custom roles found in that server yet. Create some in Discord,
            then refresh.
          </p>
          <button
            type="button"
            onClick={() => roles.refetch()}
            className="rounded-full bg-discord-elevated-hover px-3 py-1 text-xs font-semibold hover:bg-discord-brand"
          >
            Refresh
          </button>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm">Required (any of these grants access)</span>
            <RoleChipGroup
              roles={roles.data ?? []}
              selected={requiredRoleIds}
              onToggle={(id) => setRequiredRoleIds((r) => toggleRoleId(r, id))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm">Admin (edit rights + raw recipe catalog access)</span>
            <RoleChipGroup
              roles={roles.data ?? []}
              selected={adminRoleIds}
              onToggle={(id) => setAdminRoleIds((r) => toggleRoleId(r, id))}
            />
          </div>
        </>
      )}

      {saveRoles.error && <p className="text-sm text-discord-red">{saveRoles.error.message}</p>}

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={requiredRoleIds.length === 0 || saveRoles.isPending}
          onClick={() =>
            saveRoles.mutate({
              guildId: guild.id,
              name: guild.name,
              discordGuildId: guild.discordGuildId,
              requiredRoleIds,
              adminRoleIds,
            })
          }
          className="rounded-full bg-discord-brand px-6 py-2 font-semibold text-white transition hover:bg-discord-brand-hover disabled:opacity-50"
        >
          {saveRoles.isPending ? "Saving..." : "Finish setup"}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="text-xs text-discord-text-muted underline hover:text-discord-text"
        >
          Skip for now — I&apos;ll add roles later
        </button>
      </div>
    </div>
  );
}

export function CreateGuildForm({ discordClientId }: { discordClientId: string }) {
  const router = useRouter();
  const [guild, setGuild] = useState<CreatedGuild | null>(null);
  const [step, setStep] = useState<1 | 2 | 3>(1);

  function finish(target: CreatedGuild) {
    router.push(`/guilds/${target.slug}`);
    router.refresh();
  }

  return (
    <div className="flex w-full max-w-lg flex-col gap-3 rounded-xl bg-discord-elevated p-6">
      <StepReveal key={step}>
        {step === 1 && (
          <NameAndServerStep
            onCreated={(created) => {
              setGuild(created);
              setStep(2);
            }}
          />
        )}
        {step === 2 && guild && (
          <AddBotStep
            guild={guild}
            discordClientId={discordClientId}
            onConfirmed={() => setStep(3)}
            onSkip={() => finish(guild)}
          />
        )}
        {step === 3 && guild && (
          <PickRolesStep guild={guild} onDone={() => finish(guild)} />
        )}
      </StepReveal>
    </div>
  );
}
