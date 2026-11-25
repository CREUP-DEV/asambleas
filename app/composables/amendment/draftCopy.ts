/**
 * The local copy of what a composer holds and has not saved yet (CLI-3,
 * ACC-ENM-3, UXM-6): the amendment composer, the members' transactional
 * composer and the Mesa's, one storage for the three. A phone may discard a
 * tab in the background without `beforeunload`, and a browser may crash or a
 * laptop run out of battery: the copy lives in `localStorage` (never
 * `sessionStorage`, which none of those keep), per account, document and
 * draft, so reopening the composer can offer «Recuperar» once.
 *
 * It is a per-viewer convenience: every access is inside try/catch and the
 * composers work the same without it. A copy is dropped on sending, on an
 * explicit discard, when it no longer fits (another base version, a stored
 * draft someone saved since) and after `DRAFT_COPY_MAX_AGE_MS`.
 *
 * Pure: the storage and the clock come in, so it is tested without a
 * browser. `useDraftCopy` ties it to a composer.
 */
import type { AmendmentOp, Block } from "~~/shared/types/content";

/** Every key starts with this; the version follows it. */
export const DRAFT_COPY_PREFIX = "composer-copy:";
/** Bump when the stored shape changes: older copies are pruned. */
export const DRAFT_COPY_VERSION = 1;
/** A copy older than this is never offered: a week. */
export const DRAFT_COPY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** The composer a copy belongs to. */
export type DraftCopyComposer =
  "amendment" | "transactional" | "session-transactional";

/** The parts of the storage the copy uses (localStorage has them). */
export type DraftCopyStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;

/** Where a copy lives. */
export interface DraftCopyPlace {
  composer: DraftCopyComposer;
  /** The account (`me.id`), never the member: one member, many accounts. */
  userId: string;
  documentId: string;
  /** The stored draft's id, or what a new one is ("new-document", "new"). */
  scope: string;
}

/**
 * What the copy was written against. It is offered back only while both
 * still hold: the operations apply to that base, and nobody saved the stored
 * draft since (a co-author's newer version is never overwritten silently).
 */
export interface DraftCopyStamp {
  baseVersionId: string | null;
  /** The stored draft's `updatedAt` this copy builds on; null when new. */
  token: string | null;
}

export interface DraftCopyEntry<T> extends DraftCopyStamp {
  /** ISO time of the last write. */
  savedAt: string;
  data: T;
}

const versionPrefix = `${DRAFT_COPY_PREFIX}v${DRAFT_COPY_VERSION}:`;

/** The key of one copy: versioned, per composer, account, document and draft. */
export function draftCopyKey(place: DraftCopyPlace): string {
  return `${versionPrefix}${place.composer}:${place.userId}:${place.documentId}:${place.scope}`;
}

/**
 * Whether the copy moved from `previous` to `next` is the same work under a
 * new name, so the copy under the old key can go: the same composer, account
 * and document, and a change of scope the composer calls a rename (a new
 * amendment that got its id once saved). Any other change keeps the old
 * copy: the account signing out or its session expiring, another document,
 * an inclusion whose transactional is gone. Work nobody gave up stays until
 * it is answered, expires or is overwritten.
 */
export function isDraftCopyRename(
  previous: DraftCopyPlace | null,
  next: DraftCopyPlace | null,
  renamed: ((from: string, to: string) => boolean) | undefined,
): boolean {
  if (!previous || !next || !renamed) return false;
  if (
    previous.composer !== next.composer ||
    previous.userId !== next.userId ||
    previous.documentId !== next.documentId ||
    previous.scope === next.scope
  ) {
    return false;
  }
  return renamed(previous.scope, next.scope);
}

function parseEntry(raw: string | null): DraftCopyEntry<unknown> | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const entry = value as Partial<DraftCopyEntry<unknown>>;
    if (typeof entry.savedAt !== "string") return null;
    if (Number.isNaN(Date.parse(entry.savedAt))) return null;
    if (!("data" in entry) || entry.data === undefined || entry.data === null)
      return null;
    return {
      savedAt: entry.savedAt,
      baseVersionId:
        typeof entry.baseVersionId === "string" ? entry.baseVersionId : null,
      token: typeof entry.token === "string" ? entry.token : null,
      data: entry.data,
    };
  } catch {
    return null;
  }
}

function expired(savedAt: string, now: number, maxAgeMs: number): boolean {
  return now - Date.parse(savedAt) > maxAgeMs;
}

/** Removes one copy. Never throws. */
export function dropDraftCopy(
  storage: DraftCopyStorage | null,
  key: string,
): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Storage blocked: nothing was kept either.
  }
}

/**
 * The copy under `key` when it can still be offered: readable, younger than
 * `maxAgeMs` and written against `stamp`. Any other is removed, so a stale
 * copy is never offered later either. The data is the caller's to check.
 */
export function readDraftCopy(
  storage: DraftCopyStorage | null,
  key: string,
  stamp: DraftCopyStamp,
  now: number,
  maxAgeMs: number = DRAFT_COPY_MAX_AGE_MS,
): DraftCopyEntry<unknown> | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (raw === null) return null;
  const entry = parseEntry(raw);
  if (
    !entry ||
    expired(entry.savedAt, now, maxAgeMs) ||
    entry.baseVersionId !== stamp.baseVersionId ||
    entry.token !== stamp.token
  ) {
    dropDraftCopy(storage, key);
    return null;
  }
  return entry;
}

/** Writes the copy; false when the storage refused it (blocked, full). */
export function writeDraftCopy<T>(
  storage: DraftCopyStorage | null,
  key: string,
  data: T,
  stamp: DraftCopyStamp,
  now: number,
): boolean {
  if (!storage) return false;
  const entry: DraftCopyEntry<T> = {
    savedAt: new Date(now).toISOString(),
    baseVersionId: stamp.baseVersionId,
    token: stamp.token,
    data,
  };
  try {
    storage.setItem(key, JSON.stringify(entry));
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes every composer copy that is expired, unreadable or of an older
 * version. Leaves any other key alone. Never throws.
 */
export function pruneDraftCopies(
  storage: DraftCopyStorage | null,
  now: number,
  maxAgeMs: number = DRAFT_COPY_MAX_AGE_MS,
): void {
  if (!storage) return;
  try {
    const stale: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(DRAFT_COPY_PREFIX)) continue;
      if (!key.startsWith(versionPrefix)) {
        stale.push(key);
        continue;
      }
      const entry = parseEntry(storage.getItem(key));
      if (!entry || expired(entry.savedAt, now, maxAgeMs)) stale.push(key);
    }
    for (const key of stale) storage.removeItem(key);
  } catch {
    // Storage blocked: nothing to prune.
  }
}

// What each composer keeps ------------------------------------------------------

/**
 * The amendment composer's copy: its operations (never the whole text, which
 * may be a long statute), or the word changed everywhere, and the answers of
 * its panel as the author left them.
 */
export interface AmendmentComposerCopy {
  ops: AmendmentOp[];
  find: string;
  replace: string;
  kind: "partial" | "formal" | null;
  justification: string;
  withOthers: boolean;
  coAuthorIds: string[];
  mainAuthorId: string | null;
  onBehalfOfMemberId: string | null;
}

/**
 * A transactional composer's copy (the members' and the Mesa's): the
 * amendments it combines, how far the passage was widened, the passage as
 * the seed had it (to tell it still fits) and the text written over it.
 */
export interface TransactionalComposerCopy {
  sourceIds: string[];
  widen: { before: number; after: number };
  passageIds: string[];
  edited: Block[];
  justification: string;
  authorIds: string[];
  authorsTouched: boolean;
  executiveAuthorIds: string[];
  mainAuthorId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Whether a stored copy has the amendment composer's shape. */
export function isAmendmentComposerCopy(
  value: unknown,
): value is AmendmentComposerCopy {
  return (
    isRecord(value) &&
    Array.isArray(value.ops) &&
    value.ops.every((op) => isRecord(op) && typeof op.op === "string") &&
    typeof value.find === "string" &&
    typeof value.replace === "string" &&
    (value.kind === null ||
      value.kind === "partial" ||
      value.kind === "formal") &&
    typeof value.justification === "string" &&
    typeof value.withOthers === "boolean" &&
    isStringArray(value.coAuthorIds) &&
    isNullableString(value.mainAuthorId) &&
    isNullableString(value.onBehalfOfMemberId)
  );
}

/** Whether a stored copy has a transactional composer's shape. */
export function isTransactionalComposerCopy(
  value: unknown,
): value is TransactionalComposerCopy {
  return (
    isRecord(value) &&
    isStringArray(value.sourceIds) &&
    isRecord(value.widen) &&
    isCount(value.widen.before) &&
    isCount(value.widen.after) &&
    isStringArray(value.passageIds) &&
    Array.isArray(value.edited) &&
    value.edited.every(
      (block) => isRecord(block) && typeof block.id === "string",
    ) &&
    typeof value.justification === "string" &&
    isStringArray(value.authorIds) &&
    typeof value.authorsTouched === "boolean" &&
    isStringArray(value.executiveAuthorIds) &&
    isNullableString(value.mainAuthorId)
  );
}

/** Whether two lists hold the same ids in the same order. */
export function sameIdList(
  a: readonly string[],
  b: readonly string[],
): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * A short fingerprint of a value (its JSON's length and djb2 hash): the stamp
 * of what a copy builds on when there is no `updatedAt` to compare, such as
 * the operations of the transactional an inclusion revises.
 */
export function draftCopyFingerprint(value: unknown): string {
  const text = JSON.stringify(value) ?? "";
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  }
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}
