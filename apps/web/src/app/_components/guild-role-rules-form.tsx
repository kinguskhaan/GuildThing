"use client";

import { useEffect, useState } from "react";

import { api } from "~/trpc/react";

type Field = "rank" | "level" | "class";

interface ConditionDraft {
  field: Field;
  textValue: string;
  minNumber: string;
  maxNumber: string;
}

interface RuleDraft {
  id?: string;
  label: string;
  discordRoleId: string;
  conditions: ConditionDraft[];
}

function emptyCondition(): ConditionDraft {
  return { field: "rank", textValue: "", minNumber: "", maxNumber: "" };
}

function emptyRule(): RuleDraft {
  return { label: "", discordRoleId: "", conditions: [emptyCondition()] };
}

export function GuildRoleRulesForm({ guildId }: { guildId: string }) {
  const utils = api.useUtils();
  const config = api.guild.discordRoleConfig.useQuery({ guildId });
  const rankOptions = api.guild.rosterRankOptions.useQuery({ guildId });
  const classOptions = api.guild.rosterClassOptions.useQuery({ guildId });

  const [pugRoleId, setPugRoleId] = useState("");
  const [rules, setRules] = useState<RuleDraft[]>([]);

  useEffect(() => {
    if (!config.data) return;
    setPugRoleId(config.data.pugRoleId ?? "");
    setRules(
      config.data.rules.map((r) => ({
        id: r.id,
        label: r.label ?? "",
        discordRoleId: r.discordRoleId,
        conditions: r.conditions.map((c) => ({
          field: c.field as Field,
          textValue: c.textValue ?? "",
          minNumber: c.minNumber != null ? String(c.minNumber) : "",
          maxNumber: c.maxNumber != null ? String(c.maxNumber) : "",
        })),
      })),
    );
  }, [config.data]);

  const setPugRole = api.guild.setPugRole.useMutation({
    onSuccess: async () => utils.guild.discordRoleConfig.invalidate({ guildId }),
  });
  const upsertRule = api.guild.upsertRoleRule.useMutation({
    onSuccess: async () => utils.guild.discordRoleConfig.invalidate({ guildId }),
  });
  const deleteRule = api.guild.deleteRoleRule.useMutation({
    onSuccess: async () => utils.guild.discordRoleConfig.invalidate({ guildId }),
  });

  function updateRule(index: number, patch: Partial<RuleDraft>) {
    setRules((rs) => rs.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function updateCondition(
    ruleIndex: number,
    condIndex: number,
    patch: Partial<ConditionDraft>,
  ) {
    setRules((rs) =>
      rs.map((r, i) =>
        i === ruleIndex
          ? {
              ...r,
              conditions: r.conditions.map((c, j) =>
                j === condIndex ? { ...c, ...patch } : c,
              ),
            }
          : r,
      ),
    );
  }

  function saveRule(index: number) {
    const rule = rules[index];
    if (!rule) return;
    upsertRule.mutate({
      id: rule.id,
      guildId,
      label: rule.label.trim() === "" ? undefined : rule.label,
      discordRoleId: rule.discordRoleId,
      conditions: rule.conditions.map((c) =>
        c.field === "level"
          ? {
              field: "level" as const,
              operator: "between" as const,
              minNumber: Number(c.minNumber),
              maxNumber: Number(c.maxNumber),
            }
          : {
              field: c.field,
              operator: "equals" as const,
              textValue: c.textValue,
            },
      ),
    });
  }

  function removeRule(index: number) {
    const rule = rules[index];
    if (rule?.id) {
      deleteRule.mutate({ guildId, id: rule.id });
    }
    setRules((rs) => rs.filter((_, i) => i !== index));
  }

  return (
    <div className="flex w-full max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-2 rounded-xl bg-discord-elevated p-6">
        <h3 className="font-bold">PUG role</h3>
        <p className="text-sm text-discord-text-muted">
          Given automatically when someone tells the bot they&apos;re here
          for a PUG, not as a guild member — no rules are evaluated for them.
        </p>
        <div className="flex gap-2">
          <input
            className="flex-1 rounded-full bg-discord-base px-4 py-2 text-discord-text"
            value={pugRoleId}
            onChange={(e) => setPugRoleId(e.target.value)}
            placeholder="Discord role ID"
          />
          <button
            type="button"
            onClick={() =>
              setPugRole.mutate({
                guildId,
                discordRoleId: pugRoleId.trim() === "" ? null : pugRoleId,
              })
            }
            disabled={setPugRole.isPending}
            className="rounded-full bg-discord-elevated-hover px-4 text-sm font-semibold"
          >
            Save
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <div>
          <h3 className="font-bold">Role rules</h3>
          <p className="text-sm text-discord-text-muted">
            Each rule grants its role when every one of its conditions is met
            by at least one of the person&apos;s characters (main or an alt)
            — different conditions can be matched by different characters.
          </p>
        </div>

        {rules.map((rule, i) => (
          <div
            key={rule.id ?? `new-${i}`}
            className="flex flex-col gap-3 rounded-xl bg-discord-elevated p-6"
          >
            <div className="flex gap-2">
              <input
                className="flex-1 rounded-full bg-discord-base px-4 py-2 text-discord-text"
                value={rule.label}
                onChange={(e) => updateRule(i, { label: e.target.value })}
                placeholder="Label (optional, e.g. 'Wailing Caverns raiders')"
              />
              <input
                className="flex-1 rounded-full bg-discord-base px-4 py-2 text-discord-text"
                value={rule.discordRoleId}
                onChange={(e) => updateRule(i, { discordRoleId: e.target.value })}
                placeholder="Discord role ID to grant"
              />
              <button
                type="button"
                onClick={() => removeRule(i)}
                className="rounded-full bg-discord-base px-3 text-sm hover:bg-discord-elevated-hover"
              >
                ✕
              </button>
            </div>

            <div className="flex flex-col gap-2 pl-4">
              {rule.conditions.map((cond, j) => (
                <div key={j} className="flex items-center gap-2">
                  <select
                    className="rounded-full bg-discord-base px-3 py-1.5 text-sm text-discord-text"
                    value={cond.field}
                    onChange={(e) =>
                      updateCondition(i, j, { field: e.target.value as Field })
                    }
                  >
                    <option value="rank">Rank</option>
                    <option value="level">Level</option>
                    <option value="class">Class</option>
                  </select>

                  {cond.field === "level" ? (
                    <>
                      <input
                        type="number"
                        className="w-20 rounded-full bg-discord-base px-3 py-1.5 text-sm text-discord-text"
                        value={cond.minNumber}
                        onChange={(e) =>
                          updateCondition(i, j, { minNumber: e.target.value })
                        }
                        placeholder="Min"
                      />
                      <span className="text-discord-text-muted">–</span>
                      <input
                        type="number"
                        className="w-20 rounded-full bg-discord-base px-3 py-1.5 text-sm text-discord-text"
                        value={cond.maxNumber}
                        onChange={(e) =>
                          updateCondition(i, j, { maxNumber: e.target.value })
                        }
                        placeholder="Max"
                      />
                    </>
                  ) : (
                    <input
                      list={cond.field === "rank" ? "rank-options" : "class-options"}
                      className="flex-1 rounded-full bg-discord-base px-3 py-1.5 text-sm text-discord-text"
                      value={cond.textValue}
                      onChange={(e) =>
                        updateCondition(i, j, { textValue: e.target.value })
                      }
                      placeholder={
                        cond.field === "rank"
                          ? "Exact rank name"
                          : "Exact class (e.g. WARRIOR)"
                      }
                    />
                  )}

                  {rule.conditions.length > 1 && (
                    <button
                      type="button"
                      onClick={() =>
                        updateRule(i, {
                          conditions: rule.conditions.filter((_, k) => k !== j),
                        })
                      }
                      className="rounded-full bg-discord-base px-2 text-xs hover:bg-discord-elevated-hover"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  updateRule(i, {
                    conditions: [...rule.conditions, emptyCondition()],
                  })
                }
                className="self-start rounded-full bg-discord-base px-3 py-1 text-xs hover:bg-discord-elevated-hover"
              >
                + Add condition
              </button>
            </div>

            <button
              type="button"
              onClick={() => saveRule(i)}
              disabled={upsertRule.isPending || !rule.discordRoleId}
              className="self-start rounded-full bg-discord-elevated-hover px-6 py-2 text-sm font-semibold"
            >
              {upsertRule.isPending ? "Saving..." : "Save rule"}
            </button>
            {upsertRule.error && (
              <p className="text-sm text-discord-red">
                {upsertRule.error.message}
              </p>
            )}
          </div>
        ))}

        <button
          type="button"
          onClick={() => setRules((rs) => [...rs, emptyRule()])}
          className="self-start rounded-full bg-discord-elevated px-6 py-2 text-sm font-semibold transition hover:bg-discord-elevated-hover"
        >
          + Add rule
        </button>
      </div>

      <datalist id="rank-options">
        {rankOptions.data?.map((r) => <option key={r} value={r} />)}
      </datalist>
      <datalist id="class-options">
        {classOptions.data?.map((c) => <option key={c} value={c} />)}
      </datalist>
    </div>
  );
}
