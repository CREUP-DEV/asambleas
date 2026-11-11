// Bundles the scripts the production image runs outside Nuxt (migrations,
// the RBAC seed and the one-off slug recalculation) into self-contained files in dist/ops, packages included, so
// the image needs no node_modules for them. The Dockerfile copies them to
// /app/ops, next to /app/drizzle, which migrate.mjs finds as ../drizzle.
import { build } from "esbuild";

const ENTRIES = {
  migrate: "ops/migrate.mjs",
  seed: "drizzle/seed.ts",
  "reslug-documents": "drizzle/reslug-documents.ts",
};

await build({
  entryPoints: ENTRIES,
  outdir: "dist/ops",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  // pg loads its native binding only when asked for (pg.native), which the
  // scripts never do.
  external: ["pg-native"],
  // CommonJS packages (pg, dotenv) call require() for Node built-ins, which an
  // ES module bundle does not define.
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  logLevel: "info",
});
