import "~/styles/globals.css";
import "~/styles/discord-controls.css";

import { type Metadata } from "next";
import {
  Chakra_Petch,
  Geist,
  Share_Tech_Mono,
  Silkscreen,
} from "next/font/google";

import { TRPCReactProvider } from "~/trpc/react";

export const metadata: Metadata = {
  title: "guildthing",
  description:
    "Manage your guild's Discord with a bot — sync roles to guild ranks, gate channels by rank and class. Self-hosted, private by default, MIT licensed.",
  icons: [{ rel: "icon", url: "/favicon.ico" }],
};

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
});
const silkscreen = Silkscreen({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-arcade-display",
});

const chakraPetch = Chakra_Petch({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-arcade-ui",
});

const shareTechMono = Share_Tech_Mono({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-arcade-mono",
});

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geist.variable} ${silkscreen.variable} ${chakraPetch.variable} ${shareTechMono.variable}`}>
      <body>
        <TRPCReactProvider>{children}</TRPCReactProvider>

      </body>
    </html>
  );
}
