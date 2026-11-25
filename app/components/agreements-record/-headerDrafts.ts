/**
 * The certification's drafts («Quien certifica», «Cargo», «Ciudad») when the
 * record comes back from the server (E-157). A field takes the server's
 * words only while its draft still reads what was synced last: saving one
 * field never wipes what is being typed in another, and a field nobody is
 * editing follows the server. `synced` keeps, per field, the words synced
 * last; the first call fills every draft.
 */
export function syncHeaderDrafts<K extends string>(
  drafts: Record<K, string>,
  synced: Partial<Record<K, string>>,
  fields: readonly { key: K; corrected: string | null }[],
): void {
  for (const field of fields) {
    const next = field.corrected ?? "";
    const last = synced[field.key];
    if (last === undefined || drafts[field.key] === last) {
      drafts[field.key] = next;
    }
    synced[field.key] = next;
  }
}

/**
 * Lets a field's draft go after a save refused for a stale lock (409): the
 * next sync then gives it the server's words, someone else's correction
 * included, instead of keeping the refused words to send again with the
 * new lock and overwrite it. Other failures keep what was typed.
 */
export function releaseHeaderDraft<K extends string>(
  drafts: Record<K, string>,
  synced: Partial<Record<K, string>>,
  key: K,
): void {
  synced[key] = drafts[key];
}

/**
 * Whether a certification field has words to save: its trimmed draft
 * differs from what is pending for it, or else from its correction. Enter
 * and leaving the field both ask, so the same words go once.
 */
export function headerNeedsSave(
  draft: string,
  corrected: string | null,
  pending: string | undefined,
): boolean {
  return draft.trim() !== (pending ?? corrected ?? "");
}
