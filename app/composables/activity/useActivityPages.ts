import type { Ref } from "vue";
import { mergeUniqueBy } from "./-present";

/** A page of an activity list (ActivityPageDto, AdminImpersonationPageDto...). */
export interface ActivityPageLike<T> {
  items: T[];
  nextCursor: string | null;
}

export interface UseActivityPagesOptions<T> {
  /** useAsyncData key, unique per list. */
  key: string;
  url: string;
  /** The list's filters, without the cursor. A change starts over. */
  query: Ref<Record<string, string | undefined>>;
  /** Unique key of an item, to drop one a later page repeats. */
  keyOf: (item: T) => string;
  /** While false nothing is fetched (another view of the page is shown). */
  enabled?: Ref<boolean>;
}

/**
 * A keyset-paged activity list: the first page is fetched with the page
 * (server-rendered), "Cargar más" appends the next ones through the
 * cursor, and any change of filters starts over. A page that arrives after
 * the filters changed is dropped, and each "Cargar más" leaves a sentence
 * for a polite live region ("Se han cargado 20 más").
 *
 * Call it from setup and await it: every composable runs before the first
 * await, so the component context is never lost.
 */
export async function useActivityPages<
  T,
  P extends ActivityPageLike<T> = ActivityPageLike<T>,
>(options: UseActivityPagesOptions<T>) {
  const api = useApi();
  const { t } = useI18n();
  const enabled = options.enabled ?? ref(true);

  /** The filters as a stable string, so an equal query does not refetch. */
  const signature = computed(() =>
    JSON.stringify([enabled.value, options.query.value]),
  );

  const first = useAsyncData<P | null>(
    options.key,
    async () => {
      if (!enabled.value) return null;
      return await api.get<P>(options.url, { ...options.query.value });
    },
    { watch: [signature] },
  );

  const extra = shallowRef<T[]>([]);
  const cursor = ref<string | null>(null);
  const loadingMore = ref(false);
  const moreFailed = ref(false);
  const announcement = ref("");
  /** Bumped whenever the list starts over; a page from before is stale. */
  let resetToken = 0;

  function reset(page: P | null | undefined): void {
    resetToken += 1;
    extra.value = [];
    cursor.value = page?.nextCursor ?? null;
    loadingMore.value = false;
    moreFailed.value = false;
  }

  watch(first.data, (page) => reset(page), { immediate: true });
  watch(signature, () => {
    resetToken += 1;
    loadingMore.value = false;
  });

  const items = computed<T[]>(() =>
    mergeUniqueBy(first.data.value?.items ?? [], extra.value, options.keyOf),
  );

  async function loadMore(): Promise<void> {
    const from = cursor.value;
    if (!from || loadingMore.value) return;
    const token = resetToken;
    loadingMore.value = true;
    moreFailed.value = false;
    announcement.value = "";
    try {
      const page = await api.get<P>(options.url, {
        ...options.query.value,
        cursor: from,
      });
      if (token !== resetToken) return;
      const before = items.value.length;
      extra.value = mergeUniqueBy(extra.value, page.items, options.keyOf);
      cursor.value = page.nextCursor;
      const added = items.value.length - before;
      announcement.value = t(
        "activity.list.loadedMore",
        { count: added },
        added,
      );
    } catch (error) {
      if (token !== resetToken) return;
      moreFailed.value = true;
      api.notifyError(error, "activity.list.loadMoreFailed");
    } finally {
      if (token === resetToken) loadingMore.value = false;
    }
  }

  await first;

  return {
    /** The first page as the server sent it (MeActivityPageDto adds the notice). */
    page: first.data,
    items,
    status: first.status,
    error: first.error,
    refresh: first.refresh,
    /** Pending with nothing to show yet. */
    loading: computed(
      () => first.status.value === "pending" && items.value.length === 0,
    ),
    /** Pending over a list already shown (filters changed). */
    refreshing: computed(
      () => first.status.value === "pending" && items.value.length > 0,
    ),
    hasMore: computed(() => cursor.value !== null),
    loadingMore: readonly(loadingMore),
    moreFailed: readonly(moreFailed),
    announcement: readonly(announcement),
    loadMore,
  };
}
