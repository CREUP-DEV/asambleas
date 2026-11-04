import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    // Nuxt's aliases, for modules that are not imported by relative path.
    alias: [
      { find: /^~~\//, replacement: `${root}` },
      { find: /^~\//, replacement: `${root}app/` },
    ],
  },
  test: {
    include: ["shared/**/*.test.ts", "server/**/*.test.ts", "app/**/*.test.ts"],
    environment: "node",
  },
});
