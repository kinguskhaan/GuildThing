"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Particles, { initParticlesEngine } from "@tsparticles/react";
import { loadSlim } from "@tsparticles/slim";

let enginePromise: Promise<void> | null = null;

const particlesConfig = {
  autoPlay: true,
  background: { color: { value: "#0a0a12" }, opacity: 1 },
  clear: true,
  fullScreen: { enable: true, zIndex: -1 },
  detectRetina: true,
  fpsLimit: 60,
  particles: {
    color: { value: "#ffffff" },
    move: {
      direction: "none",
      enable: true,
      outModes: { default: "out" },
      speed: 0.2,
      straight: false,
    },
    number: { value: 200 },
    opacity: { value: { min: 0.3, max: 1 } },
    shape: { type: "square" },
    size: { value: { min: 1, max: 3 } },
  },
  pauseOnBlur: true,
  pauseOnOutsideViewport: true,
} as const;

function getHue(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  if (max !== min) {
    const d = max - min;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return h * 360;
}

const COLORS = [
  "#f5c2e7",
  "#f5e0dc",
  "#f2cdcd",
  "#cba6f7",
  "#f38ba8",
  "#eba0ac",
  "#fab387",
  "#f9e2af",
  "#a6e3a1",
  "#94e2d5",
  "#89dceb",
  "#74c7ec",
  "#89b4fa",
  "#b4befe",
];

const INVADER_FILES = [
  "/assets/space-invader-1.svg",
  "/assets/space-invader-2.svg",
  "/assets/space-invader-3.svg",
  "/assets/space-invader-4.svg",
];

interface Invader {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number;
  rotationSpeed: number;
  size: number;
  color: string;
  src: string;
}

function FloatingSpaceInvaders() {
  const [invaders, setInvaders] = useState<Invader[]>([]);
  const idCounterRef = useRef(0);

  const spawnInvader = useCallback(() => {
    const size = (16 + Math.random() * 8) * 1.5;
    const side = Math.floor(Math.random() * 4);
    let x: number, y: number;

    switch (side) {
      case 0:
        x = Math.random() * window.innerWidth;
        y = -size;
        break;
      case 1:
        x = window.innerWidth + size;
        y = Math.random() * window.innerHeight;
        break;
      case 2:
        x = Math.random() * window.innerWidth;
        y = window.innerHeight + size;
        break;
      default:
        x = -size;
        y = Math.random() * window.innerHeight;
        break;
    }

    const angle =
      Math.atan2(window.innerHeight / 2 - y, window.innerWidth / 2 - x) +
      (Math.random() - 0.5);
    const speed = 0.3 + Math.random() * 0.5;

    const newInvader: Invader = {
      id: idCounterRef.current++,
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      rotation: Math.random() * 360,
      rotationSpeed: (Math.random() - 0.5) * 1,
      size,
      color: COLORS[Math.floor(Math.random() * COLORS.length)]!,
      src: INVADER_FILES[Math.floor(Math.random() * INVADER_FILES.length)]!,
    };

    setInvaders((prev) => [...prev, newInvader]);
  }, []);

  useEffect(() => {
    spawnInvader();
    const interval = setInterval(spawnInvader, 2000);
    return () => clearInterval(interval);
  }, [spawnInvader]);

  useEffect(() => {
    const updatePositions = () => {
      setInvaders((prev) => {
        const filtered = prev.filter((inv) => {
          const margin = 100;
          return (
            inv.x > -margin &&
            inv.x < window.innerWidth + margin &&
            inv.y > -margin &&
            inv.y < window.innerHeight + margin
          );
        });
        return filtered.map((inv) => ({
          ...inv,
          x: inv.x + inv.vx,
          y: inv.y + inv.vy,
          rotation: inv.rotation + inv.rotationSpeed,
        }));
      });
    };

    const interval = setInterval(updatePositions, 16);
    return () => clearInterval(interval);
  }, []);

  return (
    <>
      {invaders.map((inv) => (
        <div
          key={inv.id}
          className="pointer-events-none fixed"
          style={{
            left: inv.x,
            top: inv.y,
            width: inv.size,
            height: inv.size,
            transform: `translate(-50%, -50%) rotate(${inv.rotation}deg)`,
            zIndex: 0,
            opacity: 0.7,
            filter: `drop-shadow(0 0 4px ${inv.color})`,
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={inv.src}
            alt=""
            style={{
              width: "100%",
              height: "100%",
              filter: `brightness(0) saturate(100%) invert(1) sepia(1) saturate(5) hue-rotate(${getHue(inv.color)}deg)`,
            }}
          />
        </div>
      ))}
    </>
  );
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export function ParticlesBackground() {
  const [ready, setReady] = useState(false);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    enginePromise ??= initParticlesEngine(async (engine) => {
      await loadSlim(engine);
    });
    void enginePromise.then(() => setReady(true));
  }, []);

  if (reducedMotion) {
    return (
      <div
        className="pointer-events-none fixed inset-0 -z-10 bg-arcade-void"
        aria-hidden="true"
      />
    );
  }

  if (!ready) return null;

  return (
    <>
      <FloatingSpaceInvaders />
      <Particles id="tsparticles" options={particlesConfig} />
    </>
  );
}
