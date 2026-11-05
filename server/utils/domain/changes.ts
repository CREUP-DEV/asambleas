/**
 * What an update changed, for event payloads (`payload.changes`):
 * `{ field: { from, to } }`, one entry per field whose stored value really
 * changed. Readers render it as "field: from → to"; the visibility of the
 * entity the event is about governs who reads it.
 *
 * Values are made small and JSON-stable:
 * - dates become ISO strings and compare by instant;
 * - long texts are cut to CHANGE_TEXT_MAX_LENGTH characters, ending in "…"
 *   (they still count as changed when they differ past the cut);
 * - arrays compare element by element, in order (sort id lists first);
 * - `undefined` in `after` means "not touched" and is skipped, while `null`
 *   is a value (a cleared field); a missing `before` value reads as null.
 *
 * Never pass content blocks or correction notes: payloads are kept small and
 * free of them.
 */

/** Longest text kept in a change; a longer one is cut and ends in "…". */
export const CHANGE_TEXT_MAX_LENGTH = 500;

const ELLIPSIS = "…";

export type ChangeScalar = string | number | boolean | null;
export type ChangeValue = ChangeScalar | ChangeScalar[];

export interface FieldChange {
  from: ChangeValue;
  to: ChangeValue;
}

/** Field (or "prefix.key") → old and new value. */
export type FieldChanges = Record<string, FieldChange>;

export interface DiffChangesOptions {
  /** Fields to compare; defaults to every key of `after`. */
  keys?: readonly string[];
  /** Put before each key, such as "settings." for per-key settings. */
  prefix?: string;
  /** Text cap; defaults to CHANGE_TEXT_MAX_LENGTH. */
  maxTextLength?: number;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function toScalar(value: unknown): ChangeScalar {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  return stableJson(value);
}

/** The comparable form of a value: dates as ISO, arrays of scalars. */
export function normalizeChangeValue(value: unknown): ChangeValue {
  if (Array.isArray(value)) return value.map(toScalar);
  return toScalar(value);
}

function sameValue(a: ChangeValue, b: ChangeValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((entry, index) => entry === b[index]);
  }
  return a === b;
}

/** Cuts a text to `max` characters (code points), ending in "…". */
export function truncateChangeText(
  text: string,
  max = CHANGE_TEXT_MAX_LENGTH,
): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, Math.max(0, max - 1)).join("") + ELLIPSIS;
}

function compact(value: ChangeValue, max: number): ChangeValue {
  if (typeof value === "string") return truncateChangeText(value, max);
  if (Array.isArray(value)) {
    return value.map((entry) =>
      typeof entry === "string" ? truncateChangeText(entry, max) : entry,
    );
  }
  return value;
}

/**
 * The fields whose value differs between `before` and `after`, as
 * `{ [prefix + field]: { from, to } }`. Fields that are undefined in
 * `after` are skipped; an empty object means nothing changed.
 */
export function diffChanges(
  before: object,
  after: object,
  options: DiffChangesOptions = {},
): FieldChanges {
  const previous = before as Record<string, unknown>;
  const next = after as Record<string, unknown>;
  const max = options.maxTextLength ?? CHANGE_TEXT_MAX_LENGTH;
  const prefix = options.prefix ?? "";
  const changes: FieldChanges = {};
  for (const key of options.keys ?? Object.keys(next)) {
    if (next[key] === undefined) continue;
    const from = normalizeChangeValue(previous[key]);
    const to = normalizeChangeValue(next[key]);
    if (sameValue(from, to)) continue;
    changes[`${prefix}${key}`] = {
      from: compact(from, max),
      to: compact(to, max),
    };
  }
  return changes;
}

/** A sorted copy of an id list, so membership changes compare stably. */
export function sortedIds(ids: readonly string[] | null | undefined): string[] {
  return [...(ids ?? [])].sort();
}

/**
 * An agenda item and its descendants with their titles, in display order
 * (each item before its sub-items, siblings in the order given, which
 * loadAgendaItems already sorts), for `agenda_item_deleted.deletedItems`.
 * Empty when the root is not among the items.
 */
export function agendaSubtreeEntries(
  items: readonly { id: string; parentId: string | null; title: string }[],
  rootId: string,
): { id: string; title: string }[] {
  const children = new Map<string, (typeof items)[number][]>();
  for (const item of items) {
    if (!item.parentId) continue;
    const list = children.get(item.parentId) ?? [];
    list.push(item);
    children.set(item.parentId, list);
  }
  const root = items.find((item) => item.id === rootId);
  if (!root) return [];
  const result: { id: string; title: string }[] = [];
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current.id)) continue;
    seen.add(current.id);
    result.push({ id: current.id, title: current.title });
    const below = children.get(current.id) ?? [];
    for (let index = below.length - 1; index >= 0; index -= 1) {
      stack.push(below[index]!);
    }
  }
  return result;
}
