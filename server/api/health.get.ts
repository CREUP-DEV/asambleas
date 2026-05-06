import { createError, defineEventHandler } from "h3";
import { sql } from "drizzle-orm";
import { db } from "../db";

export default defineEventHandler(async () => {
  try {
    await db.execute(sql`SELECT 1`);
    return { status: "ok", db: "ok" };
  } catch {
    throw createError({
      statusCode: 503,
      data: { status: "error", db: "unavailable" },
    });
  }
});
