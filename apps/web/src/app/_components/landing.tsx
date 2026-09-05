"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { FaArrowRight, FaDiscord, FaDownload, FaGithub } from "react-icons/fa";

import { ParticlesBackground } from "~/app/_components/particles-background";
import { SpaceInvaderGlyph } from "~/app/_components/space-invader";

export type SignInState = { error?: string };

const REPO_URL = "https://github.com/kinguskhaan/GuildThing";
const ADDON_URL = "/downloads/GuildThing.zip";

/** One orchestrated scroll-reveal per band: translate + fade, fires once. */
function Reveal({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            observer.disconnect();
          }
        }
      },
      { threshold: 0.05 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`${className ?? ""} transition-all duration-700 ease-out ${
        visible ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0"
      }`}
    >
      {children}
    </div>
  );
}

function Hero({
  signIn,
}: {
  signIn: (prev: SignInState) => Promise<SignInState>;
}) {
  const [state, formAction, pending] = useActionState(signIn, {});

  return (
    <section
      id="top"
      className="flex min-h-[78vh] flex-col items-center justify-center py-16 text-center"
    >
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-discord-rail shadow-lg">
        <SpaceInvaderGlyph className="h-10 w-10 text-discord-brand" />
      </div>
      <h1 className="m-0 font-[family-name:var(--font-arcade-display)] text-5xl text-discord-text md:text-6xl">
        guildthing
      </h1>
      <p className="m-0 mt-5 text-balance text-xl font-bold text-discord-text">
        Your guild&apos;s Discord, on rails.
      </p>
      <p className="m-0 mt-3 max-w-xl text-balance text-sm leading-relaxed text-discord-text-muted">
        GuildThing syncs Discord roles to guild ranks, opens channels by rank
        and class, and keeps the web app, the bot and the in-game addon on one
        database.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <form action={formAction}>
          <button
            type="submit"
            disabled={pending}
            aria-busy={pending}
            className="flex cursor-pointer items-center justify-center gap-2 rounded-full bg-discord-brand px-6 py-3 font-semibold text-white transition hover:bg-discord-brand-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-discord-link disabled:cursor-not-allowed disabled:opacity-50"
          >
            <FaDiscord size={20} />
            {pending ? "Connecting…" : "Log in with Discord"}
          </button>
        </form>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          className="flex items-center justify-center gap-2 rounded-full bg-discord-elevated px-6 py-3 font-semibold text-discord-text transition hover:bg-discord-elevated-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-discord-link"
        >
          <FaGithub size={18} />
          View source
        </a>
      </div>
      {state.error ? (
        <p role="alert" className="m-0 mt-4 text-sm text-discord-red">
          {state.error}
        </p>
      ) : null}
      <p className="m-0 mt-14 font-[family-name:var(--font-arcade-mono)] text-xs text-discord-text-muted">
        the demo reel starts below
      </p>
    </section>
  );
}

function BotReel() {
  return (
    <section aria-labelledby="reel-bot" className="py-20">
      <Reveal>
        <h2
          id="reel-bot"
          className="m-0 mb-8 font-[family-name:var(--font-arcade-display)] text-2xl text-discord-text md:text-3xl"
        >
          The bot runs your Discord for you
        </h2>
        <div className="rounded-xl bg-discord-base/90 p-6 shadow-2xl backdrop-blur-sm md:p-8">
          <div className="flex items-center justify-between gap-3 border-b border-black/20 pb-4">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-discord-rail">
                <SpaceInvaderGlyph className="h-5 w-5 text-discord-brand" />
              </div>
              <span className="font-[family-name:var(--font-arcade-ui)] text-sm font-semibold text-discord-text">
                guildthing
              </span>
              <span className="rounded bg-discord-brand px-1.5 py-0.5 text-[10px] font-bold uppercase text-white">
                bot
              </span>
            </div>
            <span className="rounded-full bg-discord-rail px-2 py-0.5 text-[10px] font-bold tracking-wider text-discord-text-muted">
              DEMO DATA
            </span>
          </div>
          <div className="m-0 mt-4 flex flex-col gap-2 font-[family-name:var(--font-arcade-mono)] text-sm leading-relaxed">
            <p className="m-0 text-discord-text">
              <span className="text-discord-green">✓</span> granted{" "}
              <span className="text-discord-link">@Raider</span> to{" "}
              <span className="text-discord-text">Kromgar</span>
            </p>
            <p className="m-0 pl-5 text-discord-text-muted">
              guild rank “Raider” → Discord role, synced
            </p>
            <p className="m-0 text-discord-text">
              <span className="text-discord-green">✓</span> opened{" "}
              <span className="text-discord-link">#raider-chat</span>,{" "}
              <span className="text-discord-link">#raid-plans</span>
            </p>
            <p className="m-0 pl-5 text-discord-text-muted">
              audit log entry #412 · automation paused with one switch
            </p>
          </div>
        </div>
        <p className="m-0 mt-5 max-w-xl text-sm leading-relaxed text-discord-text-muted">
          Ranks change in the roster — roles follow on Discord, and every
          change lands in the audit log. Officers can pause all background
          automation without taking the bot offline.
        </p>
      </Reveal>
    </section>
  );
}

const CHANNEL_RULES = [
  {
    from: "Guild rank — Raider",
    to: ["#raider-chat", "#raid-plans"],
  },
  {
    from: "Class — Warlock",
    to: ["#warlock-hall"],
  },
  {
    from: "Guild rank — Initiate",
    to: ["#getting-started"],
  },
] as const;

function ChannelsReel() {
  return (
    <section aria-labelledby="reel-channels" className="py-20">
      <Reveal>
        <h2
          id="reel-channels"
          className="m-0 mb-8 font-[family-name:var(--font-arcade-display)] text-2xl text-discord-text md:text-3xl"
        >
          Channels open by rank, class — your rules{" "}
          <span className="ml-2 inline-block align-middle rounded-full bg-discord-rail px-2 py-0.5 align-middle font-sans text-[10px] font-bold tracking-wider text-discord-text-muted">
            DEMO DATA
          </span>
        </h2>
        <div className="flex flex-col gap-3">
          {CHANNEL_RULES.map((rule) => (
            <div
              key={rule.from}
              className="flex flex-col gap-3 rounded-xl bg-discord-base/90 p-4 backdrop-blur-sm md:flex-row md:items-center md:gap-4"
            >
              <span className="w-full shrink-0 rounded-lg bg-discord-elevated px-4 py-2 font-[family-name:var(--font-arcade-ui)] text-sm font-semibold text-discord-text md:w-56">
                {rule.from}
              </span>
              <FaArrowRight
                size={14}
                className="hidden shrink-0 text-discord-text-muted md:block"
                aria-hidden="true"
              />
              <span className="flex flex-wrap items-center gap-2">
                {rule.to.map((channel) => (
                  <span
                    key={channel}
                    className="rounded-full bg-discord-elevated px-3 py-1.5 font-[family-name:var(--font-arcade-mono)] text-xs text-discord-link"
                  >
                    {channel}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
        <p className="m-0 mt-5 max-w-xl text-sm leading-relaxed text-discord-text-muted">
          Role rules grant Discord roles and channels on the conditions you
          set — ranks, classes, or anything else the roster knows. Change a
          rule and the bot catches everyone up.
        </p>
      </Reveal>
    </section>
  );
}

const SURFACES = [
  {
    name: "Web app",
    caption: "roster, events, rules — this site",
  },
  {
    name: "Discord bot",
    caption: "roles, channels, automation",
  },
  {
    name: "In-game addon",
    caption: "character data, live from WoW",
  },
] as const;

function DatabaseReel() {
  return (
    <section aria-labelledby="reel-db" className="py-20">
      <Reveal>
        <h2
          id="reel-db"
          className="m-0 mb-8 font-[family-name:var(--font-arcade-display)] text-2xl text-discord-text md:text-3xl"
        >
          One database. Three ways in.
        </h2>
        <div className="rounded-xl bg-discord-base/90 p-6 backdrop-blur-sm md:p-10">
          <div className="flex flex-col items-stretch gap-4 md:flex-row md:items-center">
            <div className="flex flex-col gap-4 md:flex-1">
              {SURFACES.slice(0, 1).map((surface) => (
                <SurfaceNode key={surface.name} surface={surface} />
              ))}
            </div>
            <div
              className="hidden h-px shrink-0 bg-white/10 md:block md:w-10"
              aria-hidden="true"
            />
            <div className="rounded-xl bg-discord-rail p-5 text-center shadow-lg md:px-8">
              <p className="m-0 font-[family-name:var(--font-arcade-mono)] text-sm uppercase tracking-wider text-discord-brand">
                one database
              </p>
              <p className="m-0 mt-1 text-xs text-discord-text-muted">
                single source of truth
              </p>
            </div>
            <div
              className="hidden h-px shrink-0 bg-white/10 md:block md:w-10"
              aria-hidden="true"
            />
            <div className="flex flex-col gap-4 md:flex-1">
              {SURFACES.slice(1).map((surface) => (
                <SurfaceNode key={surface.name} surface={surface} />
              ))}
            </div>
          </div>
        </div>
        <p className="m-0 mt-5 max-w-xl text-sm leading-relaxed text-discord-text-muted">
          Enter a character once and the roster, the bot and the addon all see
          it. No spreadsheets, no re-entering anything, no surfaces drifting
          apart.
        </p>
      </Reveal>
    </section>
  );
}

function SurfaceNode({
  surface,
}: {
  surface: (typeof SURFACES)[number];
}) {
  return (
    <div className="rounded-xl bg-discord-elevated p-4 text-center">
      <p className="m-0 font-[family-name:var(--font-arcade-ui)] text-sm font-semibold text-discord-text">
        {surface.name}
      </p>
      <p className="m-0 mt-0.5 text-xs text-discord-text-muted">
        {surface.caption}
      </p>
    </div>
  );
}

const YOURS_TO_RUN = [
  {
    term: "Self-hosted",
    detail:
      "docker compose up on your own machine — one instance can serve one guild or many, your call.",
  },
  {
    term: "Private by default",
    detail:
      "New instances are owner-only. Guild data stays on your hardware unless you open the doors.",
  },
  {
    term: "Free & open source",
    detail: "MIT licensed, every line of it — the bot, the addon and this site.",
  },
] as const;

function YoursToRun() {
  return (
    <section aria-labelledby="yours" className="py-20">
      <Reveal>
        <h2
          id="yours"
          className="m-0 mb-8 font-[family-name:var(--font-arcade-display)] text-2xl text-discord-text md:text-3xl"
        >
          Yours to run
        </h2>
        <div className="rounded-xl bg-discord-base/90 p-6 shadow-2xl backdrop-blur-sm md:p-8">
          <dl className="m-0 flex flex-col">
            {YOURS_TO_RUN.map((item, index) => (
              <div
                key={item.term}
                className={`flex flex-col gap-1 py-4 md:flex-row md:items-baseline md:gap-6 ${
                  index > 0 ? "border-t border-black/20" : ""
                }`}
              >
                <dt className="m-0 w-full shrink-0 font-[family-name:var(--font-arcade-ui)] text-base font-semibold text-discord-text md:w-52">
                  {item.term}
                </dt>
                <dd className="m-0 text-sm leading-relaxed text-discord-text-muted">
                  {item.detail}
                </dd>
              </div>
            ))}
          </dl>
          <div className="mt-6 flex flex-wrap gap-3">
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 rounded-full bg-discord-elevated-hover px-4 py-2 text-sm font-semibold text-discord-text transition hover:bg-discord-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-discord-link"
            >
              <FaGithub size={15} />
              Star on GitHub
            </a>
            <a
              href={ADDON_URL}
              download
              className="flex items-center gap-2 rounded-full bg-discord-elevated-hover px-4 py-2 text-sm font-semibold text-discord-text transition hover:bg-discord-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-discord-link"
            >
              <FaDownload size={15} />
              Get the in-game addon
            </a>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

function LandingFooter() {
  return (
    <footer className="flex flex-col items-center justify-between gap-3 py-10 text-xs text-discord-text-muted md:flex-row">
      <span className="font-[family-name:var(--font-arcade-display)] tracking-wide">
        guildthing
      </span>
      <span>
        MIT licensed ·{" "}
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          className="text-discord-link transition hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-discord-link"
        >
          github.com/kinguskhaan/GuildThing
        </a>
      </span>
      <a
        href="#top"
        className="text-discord-link transition hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-discord-link"
      >
        Log in
      </a>
    </footer>
  );
}

export function Landing({
  signIn,
}: {
  signIn: (prev: SignInState) => Promise<SignInState>;
}) {
  return (
    <main className="relative w-full">
      <ParticlesBackground />
      <div className="relative z-10 mx-auto flex w-full max-w-3xl flex-col px-6">
        <Hero signIn={signIn} />
        <BotReel />
        <ChannelsReel />
        <DatabaseReel />
        <YoursToRun />
        <LandingFooter />
      </div>
    </main>
  );
}