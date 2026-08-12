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

export function EditGuildForm({
  guildId,
  initialName,
  initialDiscordGuildId,
  initialRequiredRoleIds,
  initialAdminRoleIds,
  isOwner,
  defaultOpen = false,
}: {
  guildId: string;
  initialName: string;
  initialDiscordGuildId: string;
  initialRequiredRoleIds: string[];
  initialAdminRoleIds: string[];
  isOwner: boolean;
  // The settings page renders this as its whole reason for existing, so it
  // opens straight to the form — no point collapsing it there. Everywhere
  // else (the locked-out screen in guilds/[guildSlug]/layout.tsx) it stays
  // collapsed behind a button, since it's a rarely-needed escape hatch.
  defaultOpen?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(defaultOpen);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [name, setName] = useState(initialName);
  const [discordGuildId, setDiscordGuildId] = useState(initialDiscordGuildId);
  const [requiredRoleIds, setRequiredRoleIds] = useState(
    initialRequiredRoleIds.length > 0 ? initialRequiredRoleIds : [""],
  );
  const [adminRoleIds, setAdminRoleIds] = useState(initialAdminRoleIds);

  const updateGuild = api.guild.update.useMutation({
    onSuccess: () => {
      setOpen(false);
      router.refresh();
    },
  });

  const deleteGuild = api.guild.delete.useMutation({
    onSuccess: () => {
      router.push("/guilds");
      router.refresh();
    },
  });

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-full bg-discord-elevated px-6 py-2 text-sm font-semibold hover:bg-discord-elevated-hover"
      >
        Edit guild settings
      </button>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        updateGuild.mutate({
          guildId,
          name,
          discordGuildId,
          requiredRoleIds: requiredRoleIds.filter((r) => r.trim() !== ""),
          adminRoleIds: adminRoleIds.filter((r) => r.trim() !== ""),
        });
      }}
      className="flex w-full max-w-md flex-col gap-3 rounded-xl bg-discord-elevated p-6"
    >
      <h2 className="text-xl font-bold">Edit guild settings</h2>
      <label className="flex flex-col gap-1 text-sm">
        Name
        <input
          className="rounded-full bg-discord-elevated px-4 py-2 text-discord-text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Discord server ID
        <input
          className="rounded-full bg-discord-elevated px-4 py-2 text-discord-text"
          value={discordGuildId}
          onChange={(e) => setDiscordGuildId(e.target.value)}
          required
        />
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
      {updateGuild.error && (
        <p className="text-sm text-discord-red">{updateGuild.error.message}</p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          className="rounded-full bg-discord-elevated px-6 py-2 font-semibold transition hover:bg-discord-elevated-hover"
          disabled={updateGuild.isPending}
        >
          {updateGuild.isPending ? "Saving..." : "Save"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-full bg-discord-elevated px-6 py-2 font-semibold transition hover:bg-discord-elevated-hover"
        >
          Cancel
        </button>
      </div>

      {isOwner && (
        <div className="mt-2 flex flex-col gap-2 border-t border-black/20 pt-4">
          {deleteGuild.error && (
            <p className="text-sm text-discord-red">{deleteGuild.error.message}</p>
          )}
          {!confirmingDelete ? (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="self-start rounded-full bg-discord-red/10 px-6 py-2 text-sm font-semibold text-discord-red transition hover:bg-discord-red/20"
            >
              Delete guild
            </button>
          ) : (
            <div className="flex flex-col gap-2 rounded-lg bg-discord-red/10 p-3">
              <p className="text-sm text-discord-red">
                This permanently deletes &quot;{name}&quot; and every
                character/recipe imported under it. This can&apos;t be undone.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => deleteGuild.mutate({ guildId })}
                  disabled={deleteGuild.isPending}
                  className="rounded-full bg-discord-red px-6 py-2 text-sm font-semibold text-discord-text transition hover:bg-discord-red-hover"
                >
                  {deleteGuild.isPending ? "Deleting..." : "Yes, delete it"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  className="rounded-full bg-discord-elevated px-6 py-2 text-sm font-semibold transition hover:bg-discord-elevated-hover"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </form>
  );
}
