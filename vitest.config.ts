import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: "temp/vite-cache",
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Only used when a JSON reporter is requested explicitly (--reporter=json).
    outputFile: { json: "temp/vitest/reports/output.json" },
  },
});
