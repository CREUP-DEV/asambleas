/**
 * The document 409s that are calendar rules, not a stale read: their codes
 * (`assembly_closed`, `documents_deadline_passed`) are in the catalog of
 * `shared/constants/errorReasons.ts`, which words each one, so the page
 * does not show the optimistic lock's «Alguien ha modificado estos datos».
 */

/** The diagnostic of `documents_deadline_passed` (DOCUMENTS_DEADLINE_PASSED_REASON). */
export const DOCUMENTS_DEADLINE_PASSED_MESSAGE =
  "El plazo de presentación de documentos ha terminado";
