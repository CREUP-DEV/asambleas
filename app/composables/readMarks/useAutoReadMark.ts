import type { MaybeRefOrGetter } from "vue";
import { useIntersectionObserver } from "@vueuse/core";

/**
 * Marks a published document or amendment as read once its reader reaches
 * the end of it (user's decision of 2026-11-17): `end` is an empty element
 * placed right after its text, and the mark is set the first time it comes
 * into view with the mark loaded and not read yet (never read, or changed
 * since, `changed`). A text short enough to show whole is read at once.
 * Each one is marked once while the page stays open, so taking the mark back
 * («Marcar como no leído») is not undone behind the reader's back. Nothing
 * is marked while an Admin acts as another account: looking at it as them is
 * not them reading it. What takes no mark (a draft, the account's own
 * member's work) is left alone.
 */
export function useAutoReadMark(
  kind: "document" | "amendment",
  id: MaybeRefOrGetter<string | null | undefined>,
  end: MaybeRefOrGetter<HTMLElement | null | undefined>,
): void {
  const marks = useReadMarks();
  const { impersonation } = useMe();
  const marked = new Set<string>();
  const endVisible = ref(false);

  // Another text on show has not been read to its end yet: callers key the
  // element by the id, so the observer reports the new one afresh.
  watch(
    () => toValue(id),
    () => {
      endVisible.value = false;
    },
  );
  useIntersectionObserver(
    () => toValue(end) ?? null,
    (entries) => {
      const entry = entries[entries.length - 1];
      endVisible.value = entry?.isIntersecting ?? false;
    },
  );

  watch(
    () => {
      const current = toValue(id);
      if (!current || !endVisible.value) return null;
      const mark =
        kind === "document"
          ? marks.document(current)
          : marks.amendment(current);
      return mark && !mark.own ? { id: current, state: mark.state } : null;
    },
    (target) => {
      if (!target || impersonation.value || marked.has(target.id)) return;
      marked.add(target.id);
      if (target.state === "read") return;
      void marks.set(
        kind === "document"
          ? { documentIds: [target.id] }
          : { amendmentIds: [target.id] },
        true,
      );
    },
    { immediate: true },
  );
}
