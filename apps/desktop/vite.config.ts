import { defineConfig } from "vite";

// Vite only handles the frontend; Tauri owns the native shell. `clearScreen`
// and envPrefix keep Rust compile logs readable in `pnpm tauri dev`.
export default defineConfig({
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "chrome105",
    minify: "esbuild",
    sourcemap: false,
  },
  server: {
    strictPort: true,
  },
});