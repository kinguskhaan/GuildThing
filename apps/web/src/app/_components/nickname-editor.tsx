"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { api } from "~/trpc/react";

export function NicknameEditor({
  initialNickname,
  fallback,
}: {
  initialNickname: string | null;
  fallback: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initialNickname ?? "");

  const updateNickname = api.user.updateNickname.useMutation({
    onSuccess: () => {
      setEditing(false);
      router.refresh();
    },
  });

  if (!editing) {
    return (
      <div className="flex items-center gap-2">
        <p className="font-semibold">
          {initialNickname ?? fallback}
          <span className="ml-1 font-normal text-discord-text-muted">
            (you)
          </span>
        </p>
        <button
          onClick={() => setEditing(true)}
          className="text-xs text-discord-text-muted underline hover:text-discord-text"
        >
          edit nickname
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        updateNickname.mutate({ nickname: value });
      }}
      className="flex items-center gap-2"
    >
      <input
        className="rounded-full bg-discord-elevated-hover px-3 py-1 text-sm text-discord-text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={fallback}
        maxLength={32}
        autoFocus
      />
      <button
        type="submit"
        disabled={updateNickname.isPending}
        className="text-xs text-discord-link hover:underline"
      >
        Save
      </button>
      <button
        type="button"
        onClick={() => {
          setValue(initialNickname ?? "");
          setEditing(false);
        }}
        className="text-xs text-discord-text-muted hover:underline"
      >
        Cancel
      </button>
    </form>
  );
}
