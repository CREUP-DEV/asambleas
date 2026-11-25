/**
 * The classes that paint a status colour (statusColors.ts says which colour),
 * written out in full: Tailwind only generates the classes it finds spelled
 * in the source. The badges' and buttons' text on a tint is `ON_TINT`, in
 * `app.config.ts`.
 */
import type { StatusColor } from "./statusColors";

/** A status dot beside a label; neutral is the dimmed text's grey. */
export const STATUS_DOT: Record<StatusColor, string> = {
  primary: "bg-primary",
  secondary: "bg-secondary",
  success: "bg-success",
  info: "bg-info",
  warning: "bg-warning",
  error: "bg-error",
  neutral: "bg-(--ui-text-dimmed)",
};

/**
 * A result written in its colour on the page, not on a tint (AGENTS.md lets
 * only a result keep its colour): the projection's list of amendments and
 * result headings, and the live view's VoteResult. Error is a step lighter
 * than the others in light mode.
 */
export const OUTCOME_TEXT = {
  success: "text-(--ui-color-success-800) dark:text-(--ui-color-success-300)",
  warning: "text-(--ui-color-warning-800) dark:text-(--ui-color-warning-300)",
  error: "text-(--ui-color-error-700) dark:text-(--ui-color-error-300)",
} as const satisfies Partial<Record<StatusColor, string>>;

/**
 * A box tinted with a status, its text neutral (AGENTS.md): the console's
 * current amendment by its stage, and the result of a final or an item's
 * vote. A box that needs another strength keeps its own classes.
 */
export const STATUS_BOX = {
  info: "border-info/40 bg-info/5",
  warning: "border-warning/50 bg-warning/5",
  success: "border-success/50 bg-success/10",
  error: "border-error/50 bg-error/10",
} as const satisfies Partial<Record<StatusColor, string>>;
