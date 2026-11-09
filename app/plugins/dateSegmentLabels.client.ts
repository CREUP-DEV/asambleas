/**
 * Date and time fields (UInputDate, from reka-ui) name their segments in
 * English whatever the locale: "day,", "month, " and "Empty" are hardcoded
 * in reka-ui's useDateField. A screen reader would read them in English in a
 * Spanish page. This plugin relabels every segment spin button in the UI
 * language, now and whenever reka-ui renders or resets one, and again when
 * the language changes.
 */

const SEGMENTS = new Set(["day", "month", "year", "hour", "minute"]);
const SEGMENT_SELECTOR = "[data-segment][role=spinbutton]";

export default defineNuxtPlugin((nuxtApp) => {
  const i18n = nuxtApp.$i18n;

  function relabel(element: HTMLElement): void {
    const segment = element.dataset.segment;
    if (!segment || !SEGMENTS.has(segment)) return;
    const label = i18n.t(`common.dateSegments.${segment}`);
    // Setting an attribute to its own value still notifies the observer.
    if (element.getAttribute("aria-label") !== label) {
      element.setAttribute("aria-label", label);
    }
    if (element.getAttribute("aria-valuetext") === "Empty") {
      element.setAttribute(
        "aria-valuetext",
        i18n.t("common.dateSegments.empty"),
      );
    }
  }

  function scan(root: ParentNode): void {
    root.querySelectorAll<HTMLElement>(SEGMENT_SELECTOR).forEach(relabel);
  }

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") {
        if (record.target instanceof HTMLElement) relabel(record.target);
        continue;
      }
      record.addedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        if (node.matches(SEGMENT_SELECTOR)) relabel(node);
        scan(node);
      });
    }
  });

  nuxtApp.hook("app:mounted", () => {
    scan(document.body);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-label", "aria-valuetext"],
    });
  });

  watch(i18n.locale, () => scan(document.body));
});
