import {
  CONTENT_FONT_STORAGE_KEY,
  CONTENT_FONT_VARIABLES,
  DIFF_DISPLAY_MODES,
  DIFF_DISPLAY_MODE_STORAGE_KEY,
  isContentFont,
  isDiffDisplayMode,
  JUSTIFIED_TEXT_STORAGE_KEY,
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
 * variable, and `content-ragged` while the text is not justified. Without
 * this plugin the styles default to colour mode, Raleway and justified text.
 */
export default defineNuxtPlugin(() => {
  const { diffDisplayMode, contentFont, justifiedText } =
    useAccessibilityPreferences();

  const storedMode = readStored(DIFF_DISPLAY_MODE_STORAGE_KEY);
  if (isDiffDisplayMode(storedMode)) diffDisplayMode.value = storedMode;

  const storedFont = readStored(CONTENT_FONT_STORAGE_KEY);
  if (isContentFont(storedFont)) contentFont.value = storedFont;

  const storedJustified = readStored(JUSTIFIED_TEXT_STORAGE_KEY);
  if (storedJustified === "false") justifiedText.value = false;

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

  watch(
    justifiedText,
    (justified) => {
      root.classList.toggle("content-ragged", !justified);
      writeStored(JUSTIFIED_TEXT_STORAGE_KEY, String(justified));
    },
    { immediate: true },
  );
});
