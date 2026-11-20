/**
 * The observations being written in the control sheet's row panel, one
 * entry per row (item or amendment id; cuids never collide), so what is
 * typed for a row is never lost when the panel closes or opens another row
 * while it saves (RowPanel.vue). A save's answer lands on the entry it was
 * sent for, whichever row the panel shows by then: saved, a conflict to
 * choose from, or a failure that keeps the text. An entry with nothing to
 * keep is dropped when the panel leaves its row.
 *
 * Pure, so it is unit-tested on its own (-drafts.test.ts). The leading dash
 * keeps Nuxt from registering this file as a component; import it
 * explicitly.
 */

/** Someone else's version, shown beside the reader's to choose from. */
export interface ObservationConflict {
  name: string | null;
  text: string;
  token: string | null;
}

/** The observations of one row as the panel edits them. */
export interface ObservationDraft {
  draft: string;
  /** The text and token the draft started from. */
  base: { text: string; token: string | null };
  conflict: ObservationConflict | null;
  saving: boolean;
  savedAt: number | null;
}

/** What a row of the sheet says about its observations. */
export interface ObservationRow {
  observations: string;
  observationsUpdatedAt: string | null;
  observationsEdited?: { by: string | null } | null;
}

/** An entry starting from the row's text and token (none yet: empty). */
export function newObservationDraft(
  row: ObservationRow | null | undefined,
): ObservationDraft {
  const text = row?.observations ?? "";
  return {
    draft: text,
    base: { text, token: row?.observationsUpdatedAt ?? null },
    conflict: null,
    saving: false,
    savedAt: null,
  };
}

/** Takes the row's text and token as the start of the draft. */
export function syncObservationDraft(
  entry: ObservationDraft,
  row: ObservationRow | null | undefined,
): void {
  const text = row?.observations ?? "";
  entry.base = { text, token: row?.observationsUpdatedAt ?? null };
  entry.draft = text;
}

/** Typed and not saved. */
export function observationDirty(entry: ObservationDraft): boolean {
  return entry.draft.trim() !== entry.base.text;
}

/** Something would be lost without the reader: typed, or two versions. */
export function observationUnsaved(entry: ObservationDraft): boolean {
  return observationDirty(entry) || entry.conflict !== null;
}

/** Whether the entry must outlive the panel leaving its row. */
export function keepsObservationDraft(entry: ObservationDraft): boolean {
  return entry.saving || observationUnsaved(entry);
}

/**
 * A save answered: `sent` is now the row's text. What was typed while it
 * saved stays in the draft.
 */
export function observationSaved(
  entry: ObservationDraft,
  sent: string,
  row: ObservationRow,
  now: number,
): void {
  entry.base = { text: row.observations, token: row.observationsUpdatedAt };
  if (entry.draft === sent) entry.draft = row.observations;
  entry.savedAt = now;
}

/**
 * Someone changed the observations meanwhile (409): their version to choose
 * from; the reader's draft stays as it is.
 */
export function observationConflicted(
  entry: ObservationDraft,
  row: ObservationRow,
): void {
  entry.conflict = {
    name: row.observationsEdited?.by ?? null,
    text: row.observations,
    token: row.observationsUpdatedAt,
  };
}

/** «Quedarme con la suya»: their text, nothing left to save. */
export function takeTheirObservations(entry: ObservationDraft): void {
  const theirs = entry.conflict;
  if (!theirs) return;
  entry.base = { text: theirs.text, token: theirs.token };
  entry.draft = theirs.text;
  entry.conflict = null;
}

/** «Guardar la mía encima»: the draft, over their version's token. */
export function keepMyObservations(entry: ObservationDraft): void {
  const theirs = entry.conflict;
  if (!theirs) return;
  entry.base = { text: theirs.text, token: theirs.token };
  entry.conflict = null;
}

/**
 * The panel leaves row `id`: its entry goes unless it keeps something (a
 * save on its way, a draft, a conflict).
 */
export function releaseObservationDraft(
  drafts: Map<string, ObservationDraft>,
  id: string,
): void {
  const entry = drafts.get(id);
  if (entry && !keepsObservationDraft(entry)) drafts.delete(id);
}

/** The rows whose observations would be lost: typed, or in conflict. */
export function unsavedObservationIds(
  drafts: ReadonlyMap<string, ObservationDraft>,
): string[] {
  return [...drafts.entries()]
    .filter(([, entry]) => observationUnsaved(entry))
    .map(([id]) => id);
}

/**
 * How long leaving the page waits for the saves it starts (or finds on their
 * way): a connection that hangs, as on an assembly's Wi-Fi, must not hold
 * the click with no answer; past it, what is still saving counts as unsaved.
 */
export const LEAVE_SAVE_WAIT_MS = 4000;

/**
 * Waits for `work` to settle, or `ms` at most, whichever comes first; never
 * rejects. Says whether `work` settled in time.
 */
export async function settledWithin(
  work: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([
      work.then(
        () => true,
        () => true,
      ),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
