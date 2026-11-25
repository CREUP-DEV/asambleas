import type { Ref } from "vue";

/**
 * A read that left before a write must not land after it (CON-10).
 *
 * In Nuxt only a later run of the same key drops an answer on its way:
 * writing a mutation's answer into a fetch's `data` cancels nothing, so a
 * read that left before the write would land after it and bring back what
 * the write replaced (a decided amendment back to pending for a moment).
 *
 * `cancelStaleRead(source)`, called right after the write, replaces that
 * read by one that leaves now (`dedupe: "cancel"`). With nothing on its
 * way it fetches nothing: the write's live event reads it again. While the
 * page hydrates a refresh hands back the copy it loaded with, from before
 * the write, so it waits for the app to be ready (as useReadMarks does).
 *
 * The write itself stays with the caller, through the wrapper the page
 * reads (keepLastGoodData, onlyForKey): written there it counts as good
 * data, so a failed replacement read keeps it on screen, not the old one.
 */

/** The parts of a useFetch / useAsyncData result it reads. */
export interface StaleReadSource {
  status: Readonly<Ref<string>>;
  refresh: (options: { dedupe: "cancel" }) => Promise<unknown>;
}

export interface StaleReadOptions {
  /** Whether the page is hydrating. Default: Nuxt's. */
  isHydrating?: () => boolean;
  /** Runs once the app is ready. Default: onNuxtReady. */
  onReady?: (run: () => void) => void;
}

/** Call right after writing a mutation's answer into the source's data. */
export function cancelStaleRead(
  source: StaleReadSource,
  options: StaleReadOptions = {},
): void {
  if (source.status.value !== "pending") return;
  const run = () => void source.refresh({ dedupe: "cancel" });
  const hydrating = options.isHydrating
    ? options.isHydrating()
    : Boolean(useNuxtApp().isHydrating);
  if (!hydrating) run();
  else if (options.onReady) options.onReady(run);
  else onNuxtReady(run);
}
