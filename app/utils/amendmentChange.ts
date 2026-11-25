/**
 * The marks the render engine (`shared/utils/content/render.ts`) puts on
 * what an amendment changes: inserted and deleted text, a format change, a
 * block added or removed. Whatever looks for an amendment's first change
 * (the amendment's detail, the proponent's review, the projection, which adds
 * `.cx-fmt-label`) reads this one list, so a new mark is added here once.
 */
export const AMENDMENT_CHANGE_SELECTOR =
  ".cx-ins, .cx-del, .cx-fmt, .cx-block-inserted, .cx-block-deleted";
