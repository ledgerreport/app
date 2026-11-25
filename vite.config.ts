import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig(({ isSsrBuild }) => ({
  plugins: [react(), tailwindcss()],
  build: {
    // The SSR build is the headless CLI (npm run build:cli); it needs no
    // copy of the static web assets.
    copyPublicDir: !isSsrBuild,
  },
}));
