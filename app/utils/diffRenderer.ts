import DiffMatchPatch from "diff-match-patch";
import { applyPatch } from "~~/shared/utils/diff";
import { getRichTextPlainText } from "~~/shared/utils/richText";

export type DiffDisplayMode = "color" | "marks";
export type DiffViewMode = "inline" | "sideBySide";

export interface DiffSegment {
  type: "equal" | "insert" | "delete";
  text: string;
}

const dmp = new DiffMatchPatch();

/**
 * Compute semantic diff between two strings.
 * Returns segments with type annotations.
 */
export function computeDiff(original: string, modified: string): DiffSegment[] {
  const diffs = dmp.diff_main(original, modified);
  dmp.diff_cleanupSemantic(diffs);

  return diffs.map(([op, text]) => ({
    type: op === 0 ? "equal" : op === 1 ? "insert" : "delete",
    text,
  }));
}

export function computeRichTextPatchDiff(
  baseContent: string | null,
  contentPatch: string,
): {
  originalText: string;
  modifiedText: string;
  segments: DiffSegment[];
} {
  const base = baseContent ?? "";
  const proposed = applyPatch(base, contentPatch) ?? base;
  const originalText = getRichTextPlainText(base);
  const modifiedText = getRichTextPlainText(proposed);

  return {
    originalText,
    modifiedText,
    segments: computeDiff(originalText, modifiedText),
  };
}

/**
 * Render diff segments into HTML with appropriate styling classes.
 * Supports two modes: color (green/red) and marks (underline/strikethrough).
 */
export function renderDiffHtml(
  segments: DiffSegment[],
  mode: DiffDisplayMode = "color",
): string {
  return segments
    .map((seg) => {
      const escaped = escapeHtml(seg.text);

      if (seg.type === "equal") {
        return escaped;
      }

      if (seg.type === "insert") {
        const cls =
          mode === "color" ? "diff-insert-color" : "diff-insert-marks";
        return `<ins class="${cls}">${escaped}</ins>`;
      }

      // delete
      const cls = mode === "color" ? "diff-delete-color" : "diff-delete-marks";
      return `<del class="${cls}">${escaped}</del>`;
    })
    .join("");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
