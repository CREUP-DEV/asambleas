import type { DocumentSummaryDto } from "~~/shared/types/api";
import { isPastDeadline, isWindowOpen } from "~~/shared/utils/calendar";

/**
 * A document's amendment window against the shared clock, so a window that
 * opens or closes while the page is open changes state without waiting for
 * a refetch (no live event fires when one opens or closes on time).
 */
export function useDocumentWindow(document: () => DocumentSummaryDto) {
  const { t } = useI18n();
  const now = useAppNow();

  /** Whether the document has an amendment window (as the server computes it). */
  const hasWindow = computed(() => {
    const value = document();
    return (
      value.amendable &&
      value.status === "published" &&
      value.format === "structured"
    );
  });

  /**
   * Whether the window is open right now. `window.open` is the server's
   * answer at fetch time; for a document with a window it is exactly
   * `isWindowOpen` over its dates, so it is recomputed against the clock.
   */
  const openNow = computed(() => {
    const { open, opensAt, closesAt } = document().window;
    if (!hasWindow.value) return open;
    return isWindowOpen(
      {
        opensAt: opensAt ? new Date(opensAt) : null,
        closesAt: closesAt ? new Date(closesAt) : null,
      },
      new Date(now.value),
    );
  });

  /** The countdown worth showing, if any: to its close, or to its opening. */
  const countdown = computed<{ label: string; at: string } | null>(() => {
    if (!hasWindow.value) return null;
    const { opensAt, closesAt } = document().window;
    if (openNow.value && closesAt && !isPastDeadline(closesAt, now.value)) {
      return { label: t("agenda.document.windowCloses"), at: closesAt };
    }
    if (!openNow.value && opensAt && new Date(opensAt).getTime() > now.value) {
      return { label: t("agenda.document.windowOpens"), at: opensAt };
    }
    return null;
  });

  // A closed window has nothing to show: the composer warns whoever goes to
  // present an amendment that it will be late.
  return { hasWindow, openNow, countdown };
}
