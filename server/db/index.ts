import "dotenv/config";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  ConfigError,
  requireConfigPositiveInt,
  requireConfigString,
} from "../../shared/utils/config";
import { logError } from "../utils/core/logger";
import * as schema from "./schema";

const connectionString = requireConfigString(
  process.env.DATABASE_URL,
  "DATABASE_URL",
);
const databaseTimeZone = process.env.TZ?.trim() || "Europe/Madrid";

function resolveDatabaseMaxConnections() {
  const rawValue = process.env.DATABASE_MAX_CONNECTIONS;

  if (
    rawValue === undefined ||
    rawValue === null ||
    String(rawValue).trim() === ""
  ) {
    return 20;
  }

  try {
    return requireConfigPositiveInt(rawValue, "DATABASE_MAX_CONNECTIONS");
  } catch (error) {
    if (error instanceof ConfigError) {
      logError("db.config", error);
      return 20;
    }

    throw error;
  }
}

const configuredMaxConnections = resolveDatabaseMaxConnections();

interface DatabasePoolErrorSummary {
  name: string;
  message: string;
  code?: string | number;
}

interface DatabasePoolErrorState {
  errorCount: number;
  lastErrorAt: string | null;
  lastError: DatabasePoolErrorSummary | null;
}

interface DatabasePoolStats {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  maxConnections: number;
  errorCount: number;
  lastErrorAt: string | null;
  lastError: DatabasePoolErrorSummary | null;
}

const pool = new Pool({
  connectionString,
  options: `-c statement_timeout=30000 -c timezone=${databaseTimeZone}`,
  max: configuredMaxConnections,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 30_000,
});

const poolErrorState: DatabasePoolErrorState = {
  errorCount: 0,
  lastErrorAt: null,
  lastError: null,
};

function buildDatabasePoolErrorSummary(
  error: unknown,
): DatabasePoolErrorSummary {
  if (error instanceof Error) {
    const poolError = error as Error & { code?: unknown };
    const code =
      typeof poolError.code === "string" || typeof poolError.code === "number"
        ? poolError.code
        : undefined;

    return {
      name: error.name,
      message: error.message.slice(0, 200),
      code,
    };
  }

  return {
    name: "Error",
    message: String(error).slice(0, 200),
  };
}

pool.on("error", (error) => {
  poolErrorState.errorCount += 1;
  poolErrorState.lastErrorAt = new Date().toISOString();
  poolErrorState.lastError = buildDatabasePoolErrorSummary(error);
  logError("db.pool", error);
});

export function getDatabasePoolStats(): DatabasePoolStats {
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
    maxConnections: configuredMaxConnections,
    errorCount: poolErrorState.errorCount,
    lastErrorAt: poolErrorState.lastErrorAt,
    lastError: poolErrorState.lastError,
  };
}

export const db = drizzle(pool, { schema });
