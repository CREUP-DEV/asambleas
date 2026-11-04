/**
 * Content accessibility preferences: how diffs are marked and which font
 * renders document and amendment content. They never affect the UI chrome.
 *
 * The state lives here; `plugins/accessibility.client.ts` restores it from
 * localStorage at startup and applies it to <html> whenever it changes:
 * - `diff-color` or `diff-marks` class, read by the `.cx-*` diff styles;
 * - `--user-content-font` variable, read by `.rich-text` and `.content-font`.
 */

export type DiffDisplayMode = "color" | "marks";
export type ContentFont = "raleway" | "atkinson" | "opendyslexic";

export const DIFF_DISPLAY_MODES: readonly DiffDisplayMode[] = ["color", "marks"];
export const CONTENT_FONTS: readonly ContentFont[] = [
  "raleway",
  "atkinson",
  "opendyslexic",
];

export const DIFF_DISPLAY_MODE_STORAGE_KEY = "creup:diff-display-mode";
export const CONTENT_FONT_STORAGE_KEY = "creup:content-font";

/** CSS value of `--user-content-font` for each content font. */
export const CONTENT_FONT_VARIABLES: Record<ContentFont, string> = {
  raleway: "var(--font-sans)",
  atkinson: "var(--font-atkinson)",
  opendyslexic: "var(--font-opendyslexic)",
};

export const isDiffDisplayMode = (value: unknown): value is DiffDisplayMode =>
  typeof value === "string" &&
  (DIFF_DISPLAY_MODES as readonly string[]).includes(value);

export const isContentFont = (value: unknown): value is ContentFont =>
  typeof value === "string" &&
  (CONTENT_FONTS as readonly string[]).includes(value);

export const useAccessibilityPreferences = () => {
  const diffDisplayMode = useState<DiffDisplayMode>(
    "accessibility-diff-display-mode",
    () => "color",
  );
  const contentFont = useState<ContentFont>(
    "accessibility-content-font",
    () => "raleway",
  );
  const contentFontFamily = computed(
    () => CONTENT_FONT_VARIABLES[contentFont.value],
  );

  return {
    diffDisplayMode,
    contentFont,
    /** CSS font-family value for previews of the chosen content font. */
    contentFontFamily,
  };
};
