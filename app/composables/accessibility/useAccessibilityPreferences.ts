type DiffDisplayMode = "color" | "marks";
type ContentFont = "raleway" | "atkinson" | "opendyslexic";

const DIFF_DISPLAY_MODE_KEY = "creup:diff-display-mode";
const CONTENT_FONT_KEY = "creup:content-font";

const isDiffDisplayMode = (value: string): value is DiffDisplayMode =>
  value === "color" || value === "marks";

const isContentFont = (value: string): value is ContentFont =>
  value === "raleway" || value === "atkinson" || value === "opendyslexic";

export const useAccessibilityPreferences = () => {
  const diffDisplayMode = useState<DiffDisplayMode>(
    "accessibility-diff-display-mode",
    () => "color",
  );
  const contentFont = useState<ContentFont>(
    "accessibility-content-font",
    () => "raleway",
  );

  if (import.meta.client) {
    const storedDiffMode = localStorage.getItem(DIFF_DISPLAY_MODE_KEY);
    if (storedDiffMode && isDiffDisplayMode(storedDiffMode)) {
      diffDisplayMode.value = storedDiffMode;
    }

    const storedContentFont = localStorage.getItem(CONTENT_FONT_KEY);
    if (storedContentFont && isContentFont(storedContentFont)) {
      contentFont.value = storedContentFont;
    }

    watch(diffDisplayMode, (value) => {
      localStorage.setItem(DIFF_DISPLAY_MODE_KEY, value);
    });

    watch(
      contentFont,
      (value) => {
        localStorage.setItem(CONTENT_FONT_KEY, value);
        const fontVar =
          value === "atkinson"
            ? "var(--font-atkinson)"
            : value === "opendyslexic"
              ? "var(--font-opendyslexic)"
              : "var(--font-sans)";
        document.documentElement.style.setProperty(
          "--user-content-font",
          fontVar,
        );
      },
      { immediate: true },
    );
  }

  return {
    diffDisplayMode,
    contentFont,
  };
};
