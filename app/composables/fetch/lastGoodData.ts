import {
  computed,
  shallowRef,
  watch,
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

  // Synchronous, so nothing ever sees the reset value: on failure Nuxt sets
  // the error, then resets the data, then sets the status, all in one go.
  watch(
    () => source.status.value,
    (status) => {
      if (status === "success") markGood(source.data.value);
      else if (status === "error") {
        failed.value = !isGone(source.error.value);
        // Nothing to keep when nothing good ever arrived: that is the
        // page's full error state, not stale data.
        stale.value = everGood && failed.value;
      }
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
