import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(import.meta.dirname, "src/web"),
  cacheDir: resolve(import.meta.dirname, "temp/vite-cache"),
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve(import.meta.dirname, "dist/web"),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "^/api/": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
});
