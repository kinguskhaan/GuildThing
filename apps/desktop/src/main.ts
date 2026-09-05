import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

interface Target {
  name: string;
  apiUrl: string;
  apiKey: string;
  wowDir?: string | null;
  version?: string | null;
  wtfDir?: string | null;
}

interface Config {
  targets: Target[];
}

interface Detection {
  wtfDir: string;
  addonDir: string | null;
  accounts: string[];
  rosterFound: boolean;
  recipesFound: boolean;
}

interface VersionDetection {
  defaultWowDir: string | null;
  versions: string[];
}

interface SyncEvent {
  kind: "started" | "info" | "error" | "done" | "watching";
  target: string | null;
  message: string;
  ts: number;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------------------------------------------------------- helpers

function show(el: HTMLElement, visible: boolean) {
  el.hidden = !visible;
}

function setStatus(id: string, message: string, kind: "ok" | "error" | "") {
  const el = $(id);
  el.textContent = message;
  el.className = `status ${kind}`;
}

// ---------------------------------------------------------------- wizard

let wowDir = "";
let version = "";
let detection: Detection | null = null;

async function refreshVersions(dir?: string) {
  const result = await invoke<VersionDetection>("detect_versions", {
    wowDir: dir ?? null,
  });
  if (result.defaultWowDir && !wowDir) {
    wowDir = result.defaultWowDir;
    ($("wow-dir") as HTMLInputElement).value = wowDir;
  }
  const select = $("version") as HTMLSelectElement;
  select.innerHTML = "";
  if (result.versions.length > 0) {
    for (const v of result.versions) {
      const option = document.createElement("option");
      option.value = v;
      option.textContent = v;
      select.append(option);
    }
    version = select.value;
    show($("version-pick"), result.versions.length > 1);
  } else {
    show($("version-pick"), false);
    version = "";
    detection = null;
  }
  updateNextButton();
}

async function runDetection() {
  if (!wowDir || !version) return;
  try {
    detection = await invoke<Detection>("detect_install", {
      target: { name: "wizard", apiUrl: "", apiKey: "", wowDir, version },
    });
    renderDetection();
    setStatus(
      "step2-status",
      detection.rosterFound
        ? "Found your GuildThing SavedVariables."
        : "No GuildThing SavedVariables found under this WTF folder — pick another version, or install/log in to the addon first.",
      detection.rosterFound ? "ok" : "error",
    );
    updateNextButton();
  } catch (err) {
    detection = null;
    renderDetection(String(err));
    setStatus("step2-status", String(err), "error");
    updateNextButton();
  }
}

function renderDetection(error?: string) {
  const el = $("detect-result");
  if (error !== undefined) {
    el.innerHTML = `<span class="bad">${error}</span>`;
    return;
  }
  if (!detection) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `
    <div>${detection.rosterFound
      ? '<span class="good">✓</span> Roster data found'
      : '<span class="bad">✗</span> No roster data (is the addon installed, and have you logged in at least once?)'}</div>
    <div>${detection.recipesFound
      ? '<span class="good">✓</span> Recipe/character data found'
      : '<span class="bad">—</span> No recipe data (optional)'}</div>
    <div>${detection.addonDir
      ? `<span class="good">✓</span> Addon folder: <code>${detection.addonDir}</code>`
      : '<span class="bad">✗</span> GuildThing addon not found in Interface/AddOns'}</div>
  `;
}

function updateNextButton() {
  const btn = $("btn-w2-next") as HTMLButtonElement;
  btn.disabled = !detection || !detection.rosterFound;
}

function wizardStep(n: 1 | 2 | 3) {
  show($("wizard-step-1"), n === 1);
  show($("wizard-step-2"), n === 2);
  show($("wizard-step-3"), n === 3);
  if (n === 2) {
    refreshVersions();
  }
}

// ---------------------------------------------------------------- dashboard

function addTargetCard(target: Target) {
  const card = document.createElement("div");
  card.className = "target-card";
  const label = target.name || target.apiUrl;
  card.innerHTML = `
    <div class="name">${label}</div>
    <div class="url">${target.apiUrl}</div>
    <button class="remove ghost" title="Remove this guild">×</button>
  `;
  card.querySelector("button.remove")!.addEventListener("click", async () => {
    // Re-reads the live config rather than closing over a snapshot —
    // another save may have landed since this card rendered.
    const config = await invoke<Config | null>("load_config");
    const targets = (config?.targets ?? []).filter(
      (t) => !(t.name === target.name && t.apiUrl === target.apiUrl),
    );
    await invoke("save_config", { config: { targets } });
    $("targets").innerHTML = "";
    for (const t of targets) addTargetCard(t);
  });
  $("targets").append(card);
}

async function setWatchDot(running: boolean) {
  const dot = $("watch-dot");
  const label = $("watch-label");
  dot.className = `dot ${running ? "on" : "off"}`;
  label.textContent = running ? "Watching" : "Stopped";
  const toggle = $("btn-toggle-watch") as HTMLButtonElement;
  toggle.textContent = running ? "Stop watching" : "Start watching";
}

async function refreshDashboard(config: Config | null) {
  wizardStep(1);
  show($("view-wizard"), false);
  show($("view-dashboard"), true);
  $("targets").innerHTML = "";
  for (const target of config?.targets ?? []) addTargetCard(target);
  await setWatchDot(await invoke<boolean>("watch_status"));
}

function appendLog(event: SyncEvent) {
  const log = $("log");
  const entry = document.createElement("div");
  entry.className = `entry ${event.kind}`;
  const prefix = event.target ? `[${event.target}] ` : "";
  log.append(entry);
  entry.innerHTML = `<span class="time">${new Date(event.ts).toLocaleTimeString()}</span>${prefix}${event.message}`;
  // Keep the log bounded — the session can run for days.
  while (log.childElementCount > 500) {
    log.firstElementChild!.remove();
  }
}

// ---------------------------------------------------------------- wiring

async function start() {
  const config = await invoke<Config | null>("load_config");
  if (config && config.targets.length > 0) {
    await refreshDashboard(config);
    // Resume watch mode from the previous session.
    await invoke("start_watch").catch(() => {});
    await setWatchDot(await invoke<boolean>("watch_status"));
  } else {
    show($("view-wizard"), true);
  }

  await listen<SyncEvent>("sync-event", (event) => appendLog(event.payload));
}

// Wizard: step 1
$("btn-wizard-start").addEventListener("click", () => wizardStep(2));

// Wizard: step 2
$("btn-browse").addEventListener("click", async () => {
  const dir = await open({ directory: true, multiple: false });
  if (typeof dir === "string") {
    wowDir = dir;
    ($("wow-dir") as HTMLInputElement).value = dir;
    await refreshVersions(dir);
  }
});
$("wow-dir").addEventListener("change", async (event) => {
  wowDir = (event.target as HTMLInputElement).value.trim();
  await refreshVersions(wowDir);
});
$("version").addEventListener("change", async (event) => {
  version = (event.target as HTMLSelectElement).value;
  await runDetection();
});
$("btn-w2-back").addEventListener("click", () => wizardStep(1));
$("btn-w2-next").addEventListener("click", () => wizardStep(3));

// Wizard: step 3
$("btn-w3-back").addEventListener("click", () => wizardStep(2));
$("btn-test").addEventListener("click", async () => {
  const apiUrl = ($("api-url") as HTMLInputElement).value.trim().replace(/\/+$/, "");
  const apiKey = ($("api-key") as HTMLInputElement).value.trim();
  if (!apiUrl || !apiKey) {
    setStatus("step3-status", "Fill in both the site address and the API key.", "error");
    return;
  }
  setStatus("step3-status", "Testing connection…", "");
  try {
    const result = await invoke<string>("test_connection", { apiUrl, apiKey });
    setStatus("step3-status", result, "ok");
    ($("btn-w3-save") as HTMLButtonElement).disabled = false;
    ($("btn-w3-save-another") as HTMLButtonElement).disabled = false;
  } catch (err) {
    setStatus("step3-status", String(err), "error");
    ($("btn-w3-save") as HTMLButtonElement).disabled = true;
    ($("btn-w3-save-another") as HTMLButtonElement).disabled = true;
  }
});

function readTargetFromForm(): Target {
  return {
    name: ($("target-name") as HTMLInputElement).value.trim() || "default",
    apiUrl: ($("api-url") as HTMLInputElement).value.trim().replace(/\/+$/, ""),
    apiKey: ($("api-key") as HTMLInputElement).value.trim(),
    wowDir,
    version,
  };
}

// Saving merges into the existing config instead of replacing it — several
// guilds on one install each get their own target. Same name AND apiUrl
// counts as editing an existing entry; anything else appends.
async function saveTarget(target: Target): Promise<void> {
  const existing = await invoke<Config | null>("load_config");
  const targets = [...(existing?.targets ?? [])];
  const index = targets.findIndex((t) => t.name === target.name && t.apiUrl === target.apiUrl);
  if (index >= 0) {
    targets[index] = target;
  } else {
    targets.push(target);
  }
  await invoke("save_config", { config: { targets } });
  await invoke("start_watch");
}

function clearStep3Fields() {
  ($("api-url") as HTMLInputElement).value = "";
  ($("api-key") as HTMLInputElement).value = "";
  ($("target-name") as HTMLInputElement).value = "";
  ($("btn-w3-save") as HTMLButtonElement).disabled = true;
  ($("btn-w3-save-another") as HTMLButtonElement).disabled = true;
}

$("btn-w3-save").addEventListener("click", async () => {
  const target = readTargetFromForm();
  try {
    await saveTarget(target);
    const config = await invoke<Config | null>("load_config");
    await refreshDashboard(config);
  } catch (err) {
    setStatus("step3-status", String(err), "error");
  }
});
$("btn-w3-save-another").addEventListener("click", async () => {
  const target = readTargetFromForm();
  try {
    await saveTarget(target);
    clearStep3Fields();
    setStatus("step3-status", "Saved — add next guild", "ok");
  } catch (err) {
    setStatus("step3-status", String(err), "error");
  }
});
$("btn-edit-config").addEventListener("click", async () => {
  show($("view-dashboard"), false);
  show($("view-wizard"), true);
  wizardStep(2);
});

start();