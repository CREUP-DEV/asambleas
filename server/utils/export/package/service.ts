import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { LiveMessage } from "../../domain/events";
import { db } from "../../../db";
import { assemblies } from "../../../db/schema";
import type {
  AssemblyPackageStatusDto,
  PackageOptionsDto,
} from "../../../../shared/types/api";
import { logError, logWarn } from "../../core/logger";
import { createTranslator, type ExportLocale } from "../labels";
import { getExportQueue, PACKAGE_QUEUE_NAME } from "../queue";
import { availablePackageEntries } from "./build";
import {
  filterPackagePlan,
  normalizePackageFilter,
  packageDocumentGroups,
  packageDownloadName,
  packageFilterKey,
  type PackageFilter,
} from "./filter";
import { loadPackageSource } from "./load";
import {
  packageStillPublic,
  planPackage,
  type PackageEntry,
  type PackagePlan,
  type PackageSource,
} from "./plan";
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

interface CachedSource {
  source: PackageSource | null;
  at: number;
  generation: number;
}

/** What the package shows, per assembly, and the plans made from it. */
const sources = new Map<string, CachedSource>();
const plans = new Map<string, { plan: PackagePlan; source: PackageSource }>();
/** Bumped per assembly on every change, so a plan read meanwhile is not kept. */
const generations = new Map<string, number>();
const progress = new Map<string, { done: number; total: number }>();
/** When each waiting build was queued; forgotten after QUEUED_TTL_MS. */
const queued = new Map<string, number>();
const QUEUED_TTL_MS = 30 * 60_000;
/** Packages whose last build failed, until someone asks again. */
const failures = new Set<string>();
const prebuildTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** What the package shows now, from the cache while fresh. */
async function currentSource(
  assemblyId: string,
): Promise<PackageSource | null> {
  const generation = generations.get(assemblyId) ?? 0;
  const cached = sources.get(assemblyId);
  if (
    cached &&
    cached.generation === generation &&
    Date.now() - cached.at < PLAN_TTL_MS
  ) {
    return cached.source;
  }
  const source = await loadPackageSource(assemblyId);
  if ((generations.get(assemblyId) ?? 0) === generation) {
    sources.set(assemblyId, { source, at: Date.now(), generation });
  }
  return source;
}

/** The plan of the current public state and what it was planned from. */
async function currentPlanned(
  assemblyId: string,
  locale: ExportLocale,
  editable: boolean,
): Promise<{ plan: PackagePlan; source: PackageSource } | null> {
  const source = await currentSource(assemblyId);
  if (!source) return null;
  const key = packageKey(assemblyId, locale, editable);
  const cached = plans.get(key);
  if (cached?.source === source) return cached;
  const planned = {
    plan: planPackage(source, { locale, editable }, createTranslator(locale)),
    source,
  };
  plans.set(key, planned);
  return planned;
}

async function currentPlan(
  assemblyId: string,
  locale: ExportLocale,
  editable: boolean,
): Promise<PackagePlan | null> {
  return (await currentPlanned(assemblyId, locale, editable))?.plan ?? null;
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

// Parts of the package ---------------------------------------------------------

/**
 * A part (some documents, some amendments: filter.ts) is never built nor
 * kept: it is the whole package's plan with fewer entries, zipped from the
 * pieces while it is downloaded. Its pieces are rendered by the whole
 * package's build, so a part whose pieces are missing waits for that build.
 *
 * Downloads are plain links, and the control sheet's choice is a long list
 * of ids: the filter is asked for once (POST) and named afterwards by a
 * short key, kept here for a while. A key forgotten (a restart) is answered
 * 404 `selectionExpired`, and the client asks again.
 */
const FILTER_TTL_MS = 12 * 60 * 60_000;
const FILTERS_MAX = 2_000;
const filters = new Map<string, { filter: PackageFilter; at: number }>();

/** Keeps a part's filter and answers its key. */
export function rememberPackageFilter(
  assemblyId: string,
  filter: PackageFilter,
): string {
  const normalized = normalizePackageFilter(filter);
  const key = packageFilterKey(normalized);
  const id = `${assemblyId}:${key}`;
  filters.delete(id);
  filters.set(id, { filter: normalized, at: Date.now() });
  // The oldest go first (a Map keeps the order things were set in).
  for (const [old, entry] of filters) {
    if (filters.size <= FILTERS_MAX && Date.now() - entry.at < FILTER_TTL_MS) {
      break;
    }
    filters.delete(old);
  }
  return key;
}

/** The filter a key names, or null when it was forgotten. */
export function rememberedPackageFilter(
  assemblyId: string,
  key: string,
): PackageFilter | null {
  const entry = filters.get(`${assemblyId}:${key}`);
  if (!entry || Date.now() - entry.at >= FILTER_TTL_MS) return null;
  return entry.filter;
}

async function currentPart(
  assemblyId: string,
  locale: ExportLocale,
  editable: boolean,
  filter: PackageFilter,
) {
  const planned = await currentPlanned(assemblyId, locale, editable);
  if (!planned) return null;
  return {
    ...filterPackagePlan(planned.plan, planned.source, filter),
    source: planned.source,
  };
}

/** A part's status: ready once all its pieces are there. */
export async function packagePartStatus(
  assemblyId: string,
  locale: ExportLocale,
  editable: boolean,
  filter: PackageFilter,
): Promise<AssemblyPackageStatusDto | null> {
  const part = await currentPart(assemblyId, locale, editable, filter);
  if (!part) return null;
  const summary = {
    key: packageFilterKey(filter),
    documents: part.documentCount,
    amendments: part.amendmentCount,
    dropped: part.dropped,
  };
  if (part.plan.entries.length === 0) {
    return { status: "empty", file: null, progress: null, part: summary };
  }
  const available = await availablePackageEntries(
    assemblyId,
    part.plan.entries,
  );
  if (available) {
    return {
      status: "ready",
      file: {
        builtAt: new Date().toISOString(),
        bytes: available.bytes,
        current: true,
      },
      progress: null,
      part: summary,
    };
  }
  // Some piece is still to be rendered: the whole package's build does it.
  // A whole package ready without it (a piece gone from disk) reads as
  // failed, so the dialog offers to try again.
  const whole = await packageStatus(assemblyId, locale, editable);
  return {
    status:
      whole?.status === "building" || whole?.status === "failed"
        ? whole.status
        : whole?.status === "ready"
          ? "failed"
          : "idle",
    file: null,
    progress: whole?.progress ?? null,
    part: summary,
  };
}

/** Asks for a part: queues the whole package's build when a piece is missing. */
export async function requestPackagePart(
  assemblyId: string,
  locale: ExportLocale,
  editable: boolean,
  filter: PackageFilter,
): Promise<AssemblyPackageStatusDto | null> {
  const status = await packagePartStatus(assemblyId, locale, editable, filter);
  if (!status || status.status !== "idle") return status;
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
  return packagePartStatus(assemblyId, locale, editable, filter);
}

/** What a part's download zips, or null while it cannot be handed out. */
export async function packagePartDownload(
  assemblyId: string,
  locale: ExportLocale,
  editable: boolean,
  filter: PackageFilter,
): Promise<{ entries: PackageEntry[]; filename: string } | null> {
  const part = await currentPart(assemblyId, locale, editable, filter);
  if (!part || part.plan.entries.length === 0) return null;
  const available = await availablePackageEntries(
    assemblyId,
    part.plan.entries,
  );
  if (!available) return null;
  const name = packageDownloadName(
    part.plan.root,
    part.source,
    filter,
    createTranslator(locale),
  );
  return { entries: available.entries, filename: `${name}.zip` };
}

/**
 * What the download's filters offer: the documents under the agenda items
 * that gather them, their amendments with who signs them, and those who
 * sign, all as the public reads them (the package's own source).
 */
export async function packageOptions(
  assemblyId: string,
): Promise<PackageOptionsDto | null> {
  const source = await currentSource(assemblyId);
  if (!source) return null;
  const itemById = new Map(source.items.map((item) => [item.id, item]));
  return {
    groups: packageDocumentGroups(source).map(({ item, documentIds }) => ({
      id: item.id,
      numbering: item.numbering,
      title: item.title,
      documentIds,
    })),
    documents: source.documents.map((document) => ({
      id: document.id,
      title: document.title,
      reference: document.reference,
      numbering: (() => {
        const item = itemById.get(document.agendaItemId);
        return item?.automaticFor === document.id ? item.numbering : null;
      })(),
      hasText:
        document.format === "file"
          ? document.storedFile !== null
          : document.baseVersionId !== null,
      amendments: document.amendments.map((amendment) => ({
        id: amendment.id,
        code: amendment.code,
        authorIds: amendment.authorIds,
      })),
    })),
    authors: (source.authors ?? []).map((author) => ({
      id: author.id,
      acronym: author.acronym,
      name: author.name,
      kind: author.kind,
      university: author.university,
    })),
  };
}
