import {
  createError,
  defineEventHandler,
  getHeader,
  setHeader,
  setResponseStatus,
} from "h3";
import { sql } from "drizzle-orm";
import { db, getDatabasePoolStats } from "../db";
import { getExportQueueInstance } from "../utils/export/queue";

const DATABASE_PROBE_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error("Health probe timeout")),
      timeoutMs,
    );
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

export default defineEventHandler(async (event) => {
  // Reject proxied requests — direct Docker health checks have no X-Forwarded-For header.
  if (getHeader(event, "x-forwarded-for")) {
    throw createError({ statusCode: 404 });
  }

  setHeader(event, "Cache-Control", "no-store");

  const checks: Record<string, string> = {};
  let overallStatus: "ok" | "degraded" | "error" = "ok";

  // Database check — failure makes the app non-functional
  try {
    await withTimeout(
      db.execute(sql`SELECT 1`).then(() => undefined),
      DATABASE_PROBE_TIMEOUT_MS,
    );
    checks.database = "ok";
  } catch {
    checks.database = "error";
    overallStatus = "error";
  }

  // Queue check — failure degrades (exports fail but core app still serves data)
  if (!process.env.DATABASE_URL) {
    checks.queue = "unconfigured";
    if (overallStatus === "ok") overallStatus = "degraded";
  } else if (!getExportQueueInstance()) {
    checks.queue = "unavailable";
    if (overallStatus === "ok") overallStatus = "degraded";
  } else {
    checks.queue = "ok";
  }

  if (overallStatus === "error") {
    setResponseStatus(event, 503);
  }

  return {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    checks,
    metrics: {
      db: getDatabasePoolStats(),
    },
  };
});
