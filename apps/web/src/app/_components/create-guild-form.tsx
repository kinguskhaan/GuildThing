"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { MyRoleIdChips } from "~/app/_components/my-role-id-chips";
import { RoleIdList } from "~/app/_components/role-id-list";
import { api } from "~/trpc/react";

function addRoleId(roleIds: string[], roleId: string): string[] {
  if (roleIds.includes(roleId)) return roleIds;
  const emptyIndex = roleIds.findIndex((r) => r.trim() === "");
  if (emptyIndex !== -1) {
    const next = [...roleIds];
    next[emptyIndex] = roleId;
    return next;
  }
  return [...roleIds, roleId];
}

export function CreateGuildForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [discordGuildId, setDiscordGuildId] = useState("");
  const [manualEntry, setManualEntry] = useState(false);
  const [requiredRoleIds, setRequiredRoleIds] = useState([""]);
  const [adminRoleIds, setAdminRoleIds] = useState<string[]>([]);

  const servers = api.guild.myDiscordServers.useQuery();
  const showPicker = !manualEntry && (servers.data?.length ?? 0) > 0;

  const createGuild = api.guild.create.useMutation({
    onSuccess: (guild) => {
      setName("");
      setDiscordGuildId("");
      setRequiredRoleIds([""]);
      setAdminRoleIds([]);
      router.push(`/guilds/${guild.id}`);
      router.refresh();
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        createGuild.mutate({
          name,
          discordGuildId,
          requiredRoleIds: requiredRoleIds.filter((r) => r.trim() !== ""),
          adminRoleIds: adminRoleIds.filter((r) => r.trim() !== ""),
        });
      }}
      className="flex w-full max-w-md flex-col gap-3 rounded-xl bg-discord-elevated p-6"
    >
      <h2 className="text-xl font-bold">Create a guild page</h2>
      <label className="flex flex-col gap-1 text-sm">
        Name
        <input
          className="rounded-full bg-discord-elevated px-4 py-2 text-discord-text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="E.g. Tankkingen's Crew"
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
      <RoleIdList roleIds={requiredRoleIds} onChange={setRequiredRoleIds} />
      {discordGuildId && (
        <MyRoleIdChips
          discordGuildId={discordGuildId}
          exclude={requiredRoleIds}
          onPick={(roleId) => setRequiredRoleIds(addRoleId(requiredRoleIds, roleId))}
        />
      )}
      <RoleIdList
        roleIds={adminRoleIds}
        onChange={setAdminRoleIds}
        label="Admin role IDs (optional — grants edit rights + raw recipe catalog access)"
        addLabel="+ Add admin role"
        allowEmpty
      />
      {discordGuildId && (
        <MyRoleIdChips
          discordGuildId={discordGuildId}
          exclude={adminRoleIds}
          onPick={(roleId) => setAdminRoleIds(addRoleId(adminRoleIds, roleId))}
        />
      )}
      <p className="text-xs text-discord-text-muted">
        Role IDs still need to be copied by hand — enable Developer Mode in
        Discord (Settings → Advanced) to right-click a role and copy its ID.
      </p>
      {createGuild.error && (
        <p className="text-sm text-discord-red">{createGuild.error.message}</p>
      )}
      <button
        type="submit"
        className="rounded-full bg-discord-elevated px-6 py-2 font-semibold transition hover:bg-discord-elevated-hover"
        disabled={createGuild.isPending}
      >
        {createGuild.isPending ? "Creating..." : "Create"}
      </button>
    </form>
  );
}
