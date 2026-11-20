/**
 * Pure wording of some notices (compose.ts), apart so it is unit-tested
 * without the database. Spanish only, like every email.
 */

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The lead and the note of the email saying an amendment was not admitted
 * (`amendment` is its code and the document, "ABC 4 al documento «…»"). The
 * Secretaría may declare it so while reviewing it, instead of sending it
 * back for a correction (user's decision of 2026-11-19: amendment_inadmissible
 * with `onReview`): the email says it cannot be corrected and gives the
 * Secretaría's note. The Mesa's decision gives its note too, when it left
 * one. Null note when there is none.
 */
export function inadmissibleWording(
  payload: Record<string, unknown>,
  amendment: string,
): { lead: string; note: { label: string; text: string } | null } {
  const onReview = payload.onReview === true;
  const reason = text(payload.note);
  return {
    lead: onReview
      ? `La Secretaría no ha admitido tu enmienda ${amendment}. No se puede corregir ni volver a presentar.`
      : `Tu enmienda ${amendment} no ha sido admitida.`,
    note: reason
      ? { label: onReview ? "Nota de la Secretaría" : "Nota", text: reason }
      : null,
  };
}
