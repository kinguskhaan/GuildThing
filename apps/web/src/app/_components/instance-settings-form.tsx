"use client";

import { useEffect, useState } from "react";

import { api } from "~/trpc/react";
import type { RouterOutputs } from "~/trpc/react";

type Mode = RouterOutputs["instanceSettings"]["get"]["guildCreationMode"];

const MODE_OPTIONS: { value: Mode; label: string; description: string }[] = [
  {
    value: "owner",
    label: "Owner only",
    description: "Only you can create guild pages.",
  },
  {
    value: "allowlist",
    label: "Allow-list",
    description: "You, plus specific people you add below by email.",
  },
  {
    value: "public",
    label: "Public",
    description: "Anyone who signs in can create a guild page.",
  },
];

export function InstanceSettingsForm() {
  const utils = api.useUtils();
  const settings = api.instanceSettings.get.useQuery();
  const [mode, setMode] = useState<Mode>("owner");
  const [newEmail, setNewEmail] = useState("");

  useEffect(() => {
    if (settings.data) setMode(settings.data.guildCreationMode);
  }, [settings.data]);

  const setGuildCreationMode = api.instanceSettings.setGuildCreationMode.useMutation({
    onSuccess: async () => utils.instanceSettings.get.invalidate(),
  });
  const addAllowedCreator = api.instanceSettings.addAllowedCreator.useMutation({
    onSuccess: async () => {
      setNewEmail("");
      await utils.instanceSettings.get.invalidate();
    },
  });
  const removeAllowedCreator = api.instanceSettings.removeAllowedCreator.useMutation({
    onSuccess: async () => utils.instanceSettings.get.invalidate(),
  });

  if (settings.isLoading) return null;

  if (!settings.data?.isOwner) {
    return (
      <div className="w-full max-w-lg rounded-xl bg-discord-elevated p-6 text-center text-discord-text-muted">
        Only the instance owner can view this page.
      </div>
    );
  }

  return (
    <div className="flex w-full max-w-lg flex-col gap-6">
      <div className="flex flex-col gap-2 rounded-xl bg-discord-elevated p-6">
        <h3 className="font-bold">Who can create a guild page</h3>
        <div className="flex flex-col gap-2">
          {MODE_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className="flex cursor-pointer items-start gap-2 rounded-lg p-2 hover:bg-discord-elevated-hover"
            >
              <input
                type="radio"
                name="guild-creation-mode"
                checked={mode === opt.value}
                onChange={() => setMode(opt.value)}
                className="mt-1"
              />
              <span>
                <span className="block font-semibold">{opt.label}</span>
                <span className="block text-sm text-discord-text-muted">
                  {opt.description}
                </span>
              </span>
            </label>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setGuildCreationMode.mutate({ mode })}
          disabled={setGuildCreationMode.isPending}
          className="self-start rounded-full bg-discord-elevated-hover px-4 py-1.5 text-sm font-semibold"
        >
          {setGuildCreationMode.isPending ? "Saving..." : "Save"}
        </button>
        {setGuildCreationMode.isSuccess && (
          <p className="text-sm text-discord-green">Saved!</p>
        )}
      </div>

      <div className="flex flex-col gap-2 rounded-xl bg-discord-elevated p-6">
        <h3 className="font-bold">Allow-listed emails</h3>
        <p className="text-sm text-discord-text-muted">
          Only used when the mode above is set to &quot;Allow-list&quot; —
          add someone by the email they&apos;ll sign in with (they don&apos;t
          need to have signed in yet).
        </p>
        <ul className="flex flex-col gap-2">
          {settings.data.allowedCreators.map((c) => (
            <li
              key={c.id}
              className="flex items-center justify-between rounded-lg bg-discord-base px-3 py-2 text-sm"
            >
              <span>{c.email}</span>
              <button
                type="button"
                onClick={() => removeAllowedCreator.mutate({ id: c.id })}
                disabled={removeAllowedCreator.isPending}
                className="rounded-full bg-discord-elevated px-2 py-0.5 text-xs hover:bg-discord-elevated-hover"
              >
                Remove
              </button>
            </li>
          ))}
          {settings.data.allowedCreators.length === 0 && (
            <li className="text-sm text-discord-text-muted">Nobody added yet.</li>
          )}
        </ul>
        <div className="flex gap-2">
          <input
            type="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            placeholder="friend@example.com"
            className="flex-1 rounded-full bg-discord-base px-4 py-2 text-discord-text"
          />
          <button
            type="button"
            onClick={() => addAllowedCreator.mutate({ email: newEmail })}
            disabled={addAllowedCreator.isPending || newEmail.trim() === ""}
            className="rounded-full bg-discord-elevated-hover px-4 py-2 text-sm font-semibold"
          >
            {addAllowedCreator.isPending ? "Adding..." : "Add"}
          </button>
        </div>
        {addAllowedCreator.error && (
          <p className="text-sm text-discord-red">{addAllowedCreator.error.message}</p>
        )}
      </div>
    </div>
  );
}
