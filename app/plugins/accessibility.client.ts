import {
  CONTENT_FONT_STORAGE_KEY,
  CONTENT_FONT_VARIABLES,
  DIFF_DISPLAY_MODES,
  DIFF_DISPLAY_MODE_STORAGE_KEY,
  isContentFont,
  isDiffDisplayMode,
  useAccessibilityPreferences,
} from "~/composables/accessibility/useAccessibilityPreferences";

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode or blocked storage: the preference lasts for this visit.
  }
}

/**
 * Restores the content accessibility preferences and keeps <html> in sync:
 * the diff mode class (`diff-color` / `diff-marks`) and the content font
 * variable. Without this plugin the styles default to colour mode and Raleway.
 */
export default defineNuxtPlugin(() => {
  const { diffDisplayMode, contentFont } = useAccessibilityPreferences();

  const storedMode = readStored(DIFF_DISPLAY_MODE_STORAGE_KEY);
  if (isDiffDisplayMode(storedMode)) diffDisplayMode.value = storedMode;

  const storedFont = readStored(CONTENT_FONT_STORAGE_KEY);
  if (isContentFont(storedFont)) contentFont.value = storedFont;

  const root = document.documentElement;

  watch(
    diffDisplayMode,
    (mode) => {
      for (const option of DIFF_DISPLAY_MODES) {
        root.classList.toggle(`diff-${option}`, option === mode);
      }
      writeStored(DIFF_DISPLAY_MODE_STORAGE_KEY, mode);
    },
    { immediate: true },
  );

  watch(
    contentFont,
    (font) => {
      root.style.setProperty(
        "--user-content-font",
        CONTENT_FONT_VARIABLES[font],
      );
      root.dataset.contentFont = font;
      writeStored(CONTENT_FONT_STORAGE_KEY, font);
    },
    { immediate: true },
  );
});
