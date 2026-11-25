import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Like the admin section, the assemblies section's gate
 * (`protected.ts`) checks no permission key, so every handler under
 * server/api/assemblies opens with the request's actor before anything
 * else: its first `await` inside `defineEventHandler` is requireActor,
 * requireViewer or a loader that calls one of them first
 * (resolveAssemblyRoute for the assembly's level, resolveDocumentRoute and
 * the amendment loaders below it, resolvePackageRequest for the package).
 * The route's own permission check (requireCan or a named guard) follows.
 */
const OPENERS = [
  "requireActor(",
  "requireViewer(",
  "resolveAssemblyRoute(",
  "resolveDocumentRoute(",
  "loadAmendmentDocumentContext(",
  "loadAmendmentContext(",
  "resolvePackageRequest(",
];

const assembliesDir = fileURLToPath(
  new URL("../api/assemblies", import.meta.url),
);

function handlerFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return handlerFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [path]
      : [];
  });
}

/** The code of the first `await` inside defineEventHandler, or null. */
function firstAwait(source: string): string | null {
  const start = source.indexOf("defineEventHandler(");
  if (start === -1) return null;
  const match = /\bawait\s+([^;]*)/.exec(source.slice(start));
  return match ? match[1]!.trim() : null;
}

describe("assembly endpoints", () => {
  const files = handlerFiles(assembliesDir);

  it("are all found", () => {
    // 142 on 2026-11-25: a wrong path must not pass with nothing checked.
    expect(files.length).toBeGreaterThanOrEqual(142);
  });

  it.each(files.map((file) => [relative(assembliesDir, file), file]))(
    "%s opens with the actor",
    (_name, file) => {
      const awaited = firstAwait(readFileSync(file, "utf8"));
      expect(awaited, "no await inside defineEventHandler").not.toBeNull();
      expect(
        OPENERS.some((opener) => awaited!.startsWith(opener)),
        `first await is «${awaited}»`,
      ).toBe(true);
    },
  );

  it.each(files.map((file) => [relative(assembliesDir, file), file]))(
    "%s resolves its assembly through resolveAssemblyRoute",
    (_name, file) => {
      // The prologue has one copy: a route never pairs the actor with
      // resolveAssembly of the `[assembly]` param by hand.
      expect(readFileSync(file, "utf8")).not.toMatch(
        /resolveAssembly\(\s*\w+,\s*getRouterParam\(event, "assembly"\)/,
      );
    },
  );
});
