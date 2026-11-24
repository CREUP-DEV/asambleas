import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The admin section's gate (`auth.ts`) filters by no permission key, so
 * every handler under server/api/admin must check its own before anything
 * else: the first `await` inside `defineEventHandler` is one of these
 * calls. A handler that skips it would be open to any signed-in account.
 */
const CHECKS = ["requireAnyPermission(", "requireAdmin(", "requirePermission("];

const adminDir = fileURLToPath(new URL("../api/admin", import.meta.url));

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

describe("admin endpoints", () => {
  const files = handlerFiles(adminDir);

  it("are all found", () => {
    // 17 on 2026-11-24: a wrong path must not pass with nothing checked.
    expect(files.length).toBeGreaterThanOrEqual(17);
  });

  it.each(files.map((file) => [relative(adminDir, file), file]))(
    "%s checks its own permission first",
    (_name, file) => {
      const awaited = firstAwait(readFileSync(file, "utf8"));
      expect(awaited, "no await inside defineEventHandler").not.toBeNull();
      expect(
        CHECKS.some((check) => awaited!.startsWith(check)),
        `first await is «${awaited}»`,
      ).toBe(true);
    },
  );
});
