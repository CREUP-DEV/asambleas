import {
  computed,
  getCurrentScope,
  onScopeDispose,
  shallowRef,
  toValue,
  watch,
  type MaybeRefOrGetter,
  type Ref,
  type ShallowRef,
  type WatchSource,
  type WritableComputedRef,
} from "vue";
import { errorStatus } from "../api/useApi";

/**
 * Keeping data on screen when a background refresh fails.
 *
 * When a useFetch / useAsyncData request fails, Nuxt replaces `data` with
 * the default value (undefined, or null with `default: () => null`). A live
 * refresh that fails (venue Wi-Fi drops, a 502 while the server restarts)
 * would then wipe what the page shows, unmount the section with its open
 * dialogs and unsaved text, and leave the live stream without an id.
 *
 * `keepLastGoodData` wraps the asyncData result: while the last request
 * failed it keeps answering with the last good value, and switches back as
 * soon as a request succeeds. Errors that mean the resource is gone (404 by
 * default) are let through, so pages can still show their not-found state.
 */

/** The parts of a useFetch / useAsyncData result the wrapper reads. */
export interface LastGoodDataSource<T> {
  data: Ref<T>;
  status: Readonly<Ref<string>>;
  error: Readonly<Ref<unknown>>;
}

export interface LastGoodDataOptions {
  /**
   * Forget the kept value when this changes: the source now fetches
   * something else (another document), so the old value must not stand in
   * for it.
   */
  resetOn?: WatchSource<unknown>;
  /** Errors that mean the resource is gone and must show. Default: 404. */
  isGone?: (error: unknown) => boolean;
}

export interface LastGoodData<T> {
  /**
   * The data to render: the source's, or the last good value while the
   * last request failed. Writable: writes go to the source (mutation
   * responses, optimistic updates and their rollbacks) and count as good.
   */
  data: WritableComputedRef<T | undefined>;
  /**
   * True while the last request failed and a value received earlier is
   * kept on screen. False when nothing good ever arrived (the page shows
   * its full error state instead) and for gone errors.
   */
  stale: Readonly<Ref<boolean>>;
  /**
   * True while the last request failed with an error other than gone,
   * whether or not there was anything to keep: the data on screen, if
   * any, is not up to date.
   */
  failed: Readonly<Ref<boolean>>;
}

/** 404: deleted, or hidden from this user (the resolvers answer 404). */
export function isNotFoundError(error: unknown): boolean {
  return errorStatus(error) === 404;
}

/**
 * Wraps an asyncData result so a failed refresh keeps the last good data.
 * Call it synchronously in setup, right after useFetch / useAsyncData.
 */
export function keepLastGoodData<T>(
  source: LastGoodDataSource<T>,
  options: LastGoodDataOptions = {},
): LastGoodData<T> {
  const isGone = options.isGone ?? isNotFoundError;
  const kept: ShallowRef<T | undefined> = shallowRef(source.data.value);
  const stale = shallowRef(false);
  const failed = shallowRef(false);
  // Whether a good value was ever seen. Not cleared by `resetOn`: a failure
  // right after switching to another document is still a failed refresh of
  // a screen that was showing data.
  let everGood = false;

  function markGood(value: T | undefined): void {
    kept.value = value;
    everGood = true;
    stale.value = false;
    failed.value = false;
  }

  function markFailed(error: unknown): void {
    failed.value = !isGone(error);
    // Nothing to keep when nothing good ever arrived: that is the page's
    // full error state, not stale data.
    stale.value = everGood && failed.value;
  }

  // On failure Nuxt sets the error, then resets the data while the status is
  // still "pending", then sets the status to "error", all in one go. Sync
  // watchers (Nuxt's own reactive-key watcher, a `resetOn`, a fetch key
  // computed from this data) run between those writes, so the switch to the
  // kept value must happen on the error, before the reset: from then on the
  // getter answers with the kept value and no observer ever sees the reset.
  watch(
    () => source.error.value,
    (error) => {
      if (error && source.status.value === "pending") markFailed(error);
    },
    { flush: "sync" },
  );

  watch(
    () => source.status.value,
    (status) => {
      if (status === "success") markGood(source.data.value);
      else if (status === "error") markFailed(source.error.value);
    },
    { flush: "sync", immediate: true },
  );

  // Nuxt only writes the data while a request is pending (its result, or
  // the default on failure). Any other write is the app's own: a mutation
  // response, an optimistic update, possibly through another wrapper of the
  // same fetch key. That is good data.
  watch(
    () => source.data.value,
    (value) => {
      if (source.status.value !== "pending") markGood(value);
    },
    { flush: "sync" },
  );

  if (options.resetOn) {
    watch(
      options.resetOn,
      () => {
        kept.value = undefined;
        stale.value = false;
      },
      { flush: "sync" },
    );
  }

  const data = computed<T | undefined>({
    get: () => (stale.value ? kept.value : source.data.value),
    set: (value) => {
      source.data.value = value as T;
      markGood(value);
    },
  });

  return { data, stale, failed };
}

/**
 * Hides data that belongs to another key.
 *
 * When the reactive key of a useFetch / useAsyncData changes, Nuxt seeds the
 * new key's entry with the old key's data, and it stays there until the new
 * request lands (for good if that request fails). Whatever reads the data in
 * that window takes the old record for the new one, and a mutation sent from
 * it goes to the new key's URL.
 *
 * `onlyForKey` reads as null while `keyOf(value)` differs from `key`, so the
 * page shows its loading state instead. Writes go through to the source.
 */
export function onlyForKey<T, K>(
  source: Ref<T | null | undefined>,
  key: MaybeRefOrGetter<K>,
  keyOf: (value: T) => K,
): WritableComputedRef<T | null | undefined> {
  return computed<T | null | undefined>({
    get: () => {
      const value = source.value;
      if (value === null || value === undefined) return value;
      return keyOf(value) === toValue(key) ? value : null;
    },
    set: (value) => {
      source.value = value;
    },
  });
}

/** A source `useRetryFailed` refreshes while its last request failed. */
export interface RetryableSource {
  /** The wrapper's `failed`. */
  failed: Readonly<Ref<boolean>>;
  /** The asyncData status: a request already in flight is left alone. */
  status: Readonly<Ref<string>>;
  refresh: () => Promise<unknown>;
}

export interface RetryFailedOptions {
  /** Delay before the first retry; it doubles after every failed attempt. */
  baseDelay?: number;
  /** Longest delay between attempts. */
  maxDelay?: number;
  /** Called when a retry leaves every source up to date. */
  onRecovered?: () => void;
}

const RETRY_BASE_MS = 3_000;
const RETRY_MAX_MS = 30_000;

/**
 * Retries the sources whose last refresh failed until every one succeeds,
 * with exponential backoff, for screens nobody operates (the projection):
 * live events only refresh what they touch and polls only run while the
 * stream is down, so a refresh that fails while the stream stays up would
 * otherwise never be retried. As soon as no source is failed, the retry
 * stops and the backoff starts over. Client-only; stops with the calling
 * scope.
 */
export function useRetryFailed(
  sources: RetryableSource[],
  options: RetryFailedOptions = {},
): void {
  if (import.meta.server) return;
  const baseDelay = options.baseDelay ?? RETRY_BASE_MS;
  const maxDelay = options.maxDelay ?? RETRY_MAX_MS;
  const anyFailed = computed(() =>
    sources.some((source) => source.failed.value),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let disposed = false;

  function cancel(): void {
    clearTimeout(timer);
    timer = undefined;
    attempt = 0;
  }

  function schedule(): void {
    if (disposed || timer !== undefined) return;
    const delay = Math.min(baseDelay * 2 ** attempt, maxDelay);
    attempt += 1;
    // Jitter keeps clients that failed together from retrying in lockstep.
    timer = setTimeout(() => void retry(), delay * (0.8 + Math.random() * 0.4));
  }

  async function retry(): Promise<void> {
    timer = undefined;
    const due = sources.filter(
      (source) => source.failed.value && source.status.value !== "pending",
    );
    await Promise.allSettled(due.map((source) => source.refresh()));
    if (disposed) return;
    // A source that fails again stays `failed`, so the watcher below does
    // not fire: re-arm here, with a longer delay. Sources skipped because
    // they were in flight are covered too.
    if (anyFailed.value) schedule();
    else options.onRecovered?.();
  }

  const stop = watch(
    anyFailed,
    (isFailed) => {
      if (isFailed) schedule();
      else cancel();
    },
    { flush: "sync", immediate: true },
  );

  if (getCurrentScope()) {
    onScopeDispose(() => {
      disposed = true;
      stop();
      cancel();
    });
  }
}

/** Toast id shared by every source, so one failed poll shows one toast. */
export const STALE_DATA_TOAST_ID = "stale-data";

/**
 * Tells the user, once per failure, that a refresh failed and the last
 * data stays on screen. Every source shares one toast, with a retry that
 * refreshes all the page's data.
 */
export function useStaleDataNotice(stale: WatchSource<boolean>): void {
  if (import.meta.server) return;
  const toast = useToast();
  const { t } = useI18n();
  watch(stale, (isStale, wasStale) => {
    if (!isStale || wasStale) return;
    toast.add({
      id: STALE_DATA_TOAST_ID,
      title: t("common.staleData.title"),
      description: t("common.staleData.description"),
      color: "warning",
      icon: "i-lucide-cloud-off",
      actions: [
        {
          label: t("common.staleData.retry"),
          icon: "i-lucide-refresh-ccw",
          color: "neutral",
          variant: "outline",
          onClick: () => {
            void refreshNuxtData();
          },
        },
      ],
    });
  });
}
