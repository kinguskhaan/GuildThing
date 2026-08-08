"use client";

import { useRef } from "react";

export function ConfirmButton({
  label,
  confirmLabel = "Remove",
  description,
  onConfirm,
  className,
}: {
  label: string;
  confirmLabel?: string;
  description: string;
  onConfirm: () => void;
  className?: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  return (
    <>
      <button type="button" onClick={() => dialogRef.current?.showModal()} className={className}>
        {label}
      </button>

      <dialog
        ref={dialogRef}
        className="max-w-sm rounded-xl bg-discord-elevated p-6 text-discord-text backdrop:bg-black/60"
      >
        <p className="text-sm">{description}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            className="rounded-full bg-discord-elevated-hover px-4 py-2 text-sm transition hover:bg-discord-elevated"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              dialogRef.current?.close();
              onConfirm();
            }}
            className="rounded-full bg-discord-red px-4 py-2 text-sm font-semibold transition hover:bg-discord-red-hover"
          >
            {confirmLabel}
          </button>
        </div>
      </dialog>
    </>
  );
}
