"use client";

import { useEffect } from "react";

declare global {
  interface Window {
    whTooltips?: { colorLinks: boolean; iconizeLinks: boolean; renameLinks: boolean };
    $WowheadPower?: { refreshLinks: () => void };
  }
}

const SCRIPT_ID = "wowhead-tooltips-script";

// Wowhead's official tooltip widget: any <a href="https://www.wowhead.com/
// {domain}/spell={id}"> on the page gets a real hover tooltip once this
// script has loaded — no per-spell data to maintain beyond the link itself.
// colorLinks/iconizeLinks/renameLinks are off because our own buff rows
// already render their own icon and label; we only want the hover tooltip.
export function WowheadTooltips() {
  useEffect(() => {
    window.whTooltips = { colorLinks: false, iconizeLinks: false, renameLinks: false };

    if (document.getElementById(SCRIPT_ID)) {
      // Script already loaded by another instance of this component —
      // just make sure links rendered since then are picked up.
      window.$WowheadPower?.refreshLinks();
      return;
    }
    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.src = "https://wow.zamimg.com/js/tooltips.js";
    script.async = true;
    document.head.appendChild(script);
  }, []);

  return null;
}
