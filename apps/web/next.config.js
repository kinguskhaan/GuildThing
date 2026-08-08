/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import "./src/env.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

/** @type {import("next").NextConfig} */
const config = {
  output: "standalone",
  // apps/web -> monorepo root, so Next's file tracing for the standalone
  // output covers the workspace packages it imports (@guildthing/db,
  // @guildthing/wowhead-data) instead of just this app's own directory.
  outputFileTracingRoot: path.join(__dirname, "../../"),
  transpilePackages: ["@guildthing/db", "@guildthing/wowhead-data"],
};

export default config;
