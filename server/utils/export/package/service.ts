import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { LiveMessage } from "../../domain/events";
import { db } from "../../../db";
import { assemblies } from "../../../db/schema";
import type { AssemblyPackageStatusDto } from "../../../../shared/types/api";
import { logError, logWarn } from "../../core/logger";
import type { ExportLocale } from "../labels";
import { getExportQueue, PACKAGE_QUEUE_NAME } from "../queue";
import { planCurrentPackage } from "./build";
import { packageStillPublic, type PackagePlan } from "./plan";
import {
  assemblyPackageDir,
  fileExists,
  packageVariant,
  readPackageState,
  type PackageState,
} from "./storage";

/**
 * The documentation package as the endpoints see it: what can be
 * downloaded now, what is being built, and asking for a build. One app
 * process, so the plan cache and the build progress live in its memory;
 * the queue (pg-boss, PACKAGE_QUEUE_NAME) keeps the builds themselves.
 */

/** A plan is planned again after this long, or after a change in its assembly. */
const PLAN_TTL_MS = 60_000;
/** Quiet time after a change before the package is built ahead of anyone asking. */
const PREBUILD_DELAY_MS = 2 * 60_000;
/** Assemblies whose package is built ahead: those whose documentation moves. */
const PREBUILD_STATUSES = new Set(["convened", "in_session"]);
/** The language and variants built ahead; the others are built when asked. */
const PREBUILD_LOCALE: ExportLocale = "es";

/**
 * Changes that never touch what the package shows: the session's live
 * state, speaking turns, headcounts, the control sheet and the room.
 */
const IGNORED_ENTITIES = new Set([
  "live",
  "speakers",
  "headcount",
  "control_sheet",
  "seating",
]);

export function packageKey(
  assemblyId: string,
  locale: ExportLocale,
  editable: boolean,
): string {
  return `${assemblyId}:${locale}:${packageVariant(editable)}`;
}

interface CachedPlan {
  plan: PackagePlan | null;
  at: number;
  generation: number;
}

const plans = new Map<string, CachedPlan>();
/** Bumped per assembly on every change, so a plan read meanwhile is not kept. */
const generations = new Map<string, number>();
const progress = new Map<string, { done: number; total: number }>();
/** When each waiting build was queued; forgotten after QUEUED_TTL_MS. */
const queued = new Map<string, number>();
const QUEUED_TTL_MS = 30 * 60_000;
/** Packages whose last build failed, until someone asks again. */
const failures = new Set<string>();
const prebuildTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** The plan of the current public state, from the cache while fresh. */
async function currentPlan(
  assemblyId: string,
  locale: ExportLocale,
  editable: boolean,
): Promise<PackagePlan | null> {
  const key = packageKey(assemblyId, locale, editable);
  const generation = generations.get(assemblyId) ?? 0;
  const cached = plans.get(key);
  if (
    cached &&
    cached.generation === generation &&
    Date.now() - cached.at < PLAN_TTL_MS
  ) {
    return cached.plan;
  }
  const planned = await planCurrentPackage(assemblyId, locale, editable);
  const plan = planned?.plan ?? null;
  if ((generations.get(assemblyId) ?? 0) === generation) {
    plans.set(key, { plan, at: Date.now(), generation });
  }
  return plan;
}

/** A change in the assembly: plans are read again, and a build ahead waits. */
export function onPackageLiveMessage(message: LiveMessage): void {
  if (IGNORED_ENTITIES.has(message.entityType)) return;
  if (message.type === "live_changed") return;
  generations.set(
    message.assemblyId,
    (generations.get(message.assemblyId) ?? 0) + 1,
  );
  schedulePrebuild(message.assemblyId);
}

function schedulePrebuild(assemblyId: string): void {
  clearTimeout(prebuildTimers.get(assemblyId));
  const timer = setTimeout(() => {
    prebuildTimers.delete(assemblyId);
    void prebuild(assemblyId).catch((error) =>
      logError("package.prebuild", error),
    );
  }, PREBUILD_DELAY_MS);
  timer.unref?.();
  prebuildTimers.set(assemblyId, timer);
}

async function prebuild(assemblyId: string): Promise<void> {
  const [row] = await db
    .select({ status: assemblies.status })
    .from(assemblies)
    .where(eq(assemblies.id, assemblyId));
  if (!row || !PREBUILD_STATUSES.has(row.status)) return;
  for (const editable of [false, true]) {
    await queueBuild(assemblyId, PREBUILD_LOCALE, editable);
  }
}

export function stopPackagePrebuilds(): void {
  for (const timer of prebuildTimers.values()) clearTimeout(timer);
  prebuildTimers.clear();
}

/** Queues a build unless one for the same package already waits. */
async function queueBuild(
  assemblyId: string,
  locale: ExportLocale,
  editable: boolean,
): Promise<void> {
  const key = packageKey(assemblyId, locale, editable);
  const boss = await getExportQueue();
  // Null when one already waits for its turn (the queue's stately policy).
  await boss.send(
    PACKAGE_QUEUE_NAME,
    { assemblyId, locale, editable },
    { singletonKey: key },
  );
  queued.set(key, Date.now());
}

function isQueued(key: string): boolean {
  const at = queued.get(key);
  if (at === undefined) return false;
  if (Date.now() - at < QUEUED_TTL_MS) return true;
  queued.delete(key);
  return false;
}

// Worker hooks ------------------------------------------------------------------

export function packageBuildStarted(key: string): void {
  queued.delete(key);
  failures.delete(key);
  progress.set(key, { done: 0, total: 0 });
}

export function packageBuildProgress(
  key: string,
  done: number,
  total: number,
): void {
  progress.set(key, { done, total });
}

export function packageBuildEnded(
  key: string,
  outcome?: { failed: true; retrying: boolean },
): void {
  progress.delete(key);
  if (!outcome) return;
  // A build pg-boss retries still reads as building meanwhile.
  if (outcome.retrying) queued.set(key, Date.now());
  else failures.add(key);
}

// Endpoints -----------------------------------------------------------------------

/**
 * The ZIP that may be handed out now: the last one built if it is the
 * current state's, or an older one whose content is all still public as it
 * was (packageStillPublic). Never a ZIP showing something since withdrawn.
 */
async function servableState(
  assemblyId: string,
  locale: ExportLocale,
  editable: boolean,
  plan: PackagePlan,
): Promise<{ state: PackageState; current: boolean } | null> {
  const state = await readPackageState(
    assemblyId,
    locale,
    packageVariant(editable),
  );
  if (!state) return null;
  if (
    !(await fileExists(join(assemblyPackageDir(assemblyId), state.zipFile)))
  ) {
    return null;
  }
  if (state.fingerprint === plan.fingerprint) return { state, current: true };
  return packageStillPublic(state.includes, plan.includes)
    ? { state, current: false }
    : null;
}

export async function packageStatus(
  assemblyId: string,
  locale: ExportLocale,
  editable: boolean,
): Promise<AssemblyPackageStatusDto | null> {
  const plan = await currentPlan(assemblyId, locale, editable);
  if (!plan) return null;
  const key = packageKey(assemblyId, locale, editable);
  const servable = await servableState(assemblyId, locale, editable, plan);
  const running = progress.get(key);
  const file = servable
    ? {
        builtAt: servable.state.builtAt,
        bytes: servable.state.bytes,
        current: servable.current,
      }
    : null;
  let status: AssemblyPackageStatusDto["status"];
  if (servable?.current) status = "ready";
  else if (running || isQueued(key)) status = "building";
  else if (failures.has(key)) status = "failed";
  else status = "idle";
  return {
    status,
    file,
    progress:
      status === "building" && running && running.total > 0
        ? { done: running.done, total: running.total }
        : null,
  };
}

/** Builds the package unless the current one is there; answers the status. */
export async function requestPackage(
  assemblyId: string,
  locale: ExportLocale,
  editable: boolean,
): Promise<AssemblyPackageStatusDto | null> {
  const status = await packageStatus(assemblyId, locale, editable);
  if (!status || status.status === "ready" || status.status === "building") {
    return status;
  }
  failures.delete(packageKey(assemblyId, locale, editable));
  try {
    await queueBuild(assemblyId, locale, editable);
  } catch (error) {
    logWarn("package.request", {
      assemblyId,
      reason: error instanceof Error ? error.message : "queue unavailable",
    });
    throw error;
  }
  return packageStatus(assemblyId, locale, editable);
}

/** The file to send, or null when nothing may be handed out now. */
export async function packageDownload(
  assemblyId: string,
  locale: ExportLocale,
  editable: boolean,
): Promise<{
  path: string;
  filename: string;
  bytes: number;
  fingerprint: string;
} | null> {
  const plan = await currentPlan(assemblyId, locale, editable);
  if (!plan) return null;
  const servable = await servableState(assemblyId, locale, editable, plan);
  if (!servable) return null;
  return {
    path: join(assemblyPackageDir(assemblyId), servable.state.zipFile),
    filename: `${servable.state.root}.zip`,
    bytes: servable.state.bytes,
    fingerprint: servable.state.fingerprint,
  };
}
