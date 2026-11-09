import type { MaybeRefOrGetter } from "vue";
import type {
  HeadcountBody,
  HeadcountDto,
  HeadcountsDto,
  LiveEventDto,
} from "~~/shared/types/api";
import { useApi } from "../api/useApi";
import { keepLastGoodData } from "../fetch/lastGoodData";
import { isHeadcountEvent } from "./headcountForm";

export interface HeadcountsOptions {
  /** The assembly's API base, e.g. `/api/assemblies/{id}`. */
  baseUrl: MaybeRefOrGetter<string>;
  /** Fetch key of the assembly (its route param). */
  key: MaybeRefOrGetter<string>;
  /** Only those who read headcounts fetch them. */
  enabled: MaybeRefOrGetter<boolean>;
  /** An in-flight tracker (busy keys); the console passes its own. */
  track?: <T>(key: string, run: () => Promise<T>) => Promise<T>;
}

/**
 * The Mesa's headcounts (GET .../headcounts): the latest one is the base of
 * majorities on the members present, which the vote forms fill in. Every
 * change answers with the whole list; a conflict (another Mesa device
 * corrected the same count) reloads it. Live `headcount` events from other
 * devices reload it too.
 *
 * Busy keys: `headcount-add` while a count is stored, `headcount-{id}`
 * while one is corrected.
 */
export function useHeadcounts(options: HeadcountsOptions) {
  const api = useApi();
  const toast = useToast();
  const { t } = useI18n();
  const track =
    options.track ?? (<T>(_key: string, run: () => Promise<T>) => run());

  const url = computed(() => `${toValue(options.baseUrl)}/headcounts`);

  const fetch = useAsyncData(
    () => `headcounts-${toValue(options.key)}`,
    () =>
      toValue(options.enabled)
        ? api.get<HeadcountsDto>(url.value)
        : Promise.resolve(null),
    { server: false, watch: [() => toValue(options.enabled)] },
  );
  const { data, failed } = keepLastGoodData(fetch, {
    resetOn: () => toValue(options.key),
  });

  const latest = computed<HeadcountDto | null>(
    () => data.value?.latest ?? null,
  );
  const loading = computed(
    () =>
      !data.value &&
      (fetch.status.value === "pending" || fetch.status.value === "idle"),
  );
  const unavailable = computed(
    () => !data.value && fetch.status.value === "error",
  );

  function refresh(): Promise<void> {
    return fetch.refresh();
  }

  /** Stores a new count; true once it is on the list. */
  async function add(body: HeadcountBody): Promise<boolean> {
    try {
      data.value = await track("headcount-add", () =>
        api.send<HeadcountsDto>(url.value, { body }),
      );
      return true;
    } catch (error) {
      api.notifyError(error, "session.headcount.errors.save");
      return false;
    }
  }

  /** Corrects a count; a conflict reloads the list and says so calmly. */
  async function correct(
    headcount: HeadcountDto,
    body: HeadcountBody,
  ): Promise<boolean> {
    try {
      data.value = await track(`headcount-${headcount.id}`, () =>
        api.send<HeadcountsDto>(
          `${url.value}/${encodeURIComponent(headcount.id)}`,
          { method: "PUT", body: { ...body, updatedAt: headcount.updatedAt } },
        ),
      );
      return true;
    } catch (error) {
      if (api.isConflict(error)) {
        void refresh();
        toast.add({
          id: "session-headcount-changed",
          title: t("session.headcount.changedElsewhere"),
          color: "info",
          icon: "i-lucide-refresh-ccw",
        });
      } else {
        api.notifyError(error, "session.headcount.errors.save");
      }
      return false;
    }
  }

  function onLive(events: LiveEventDto[]): void {
    if (events.some(isHeadcountEvent)) void refresh();
  }

  return {
    data,
    latest,
    loading,
    unavailable,
    failed,
    refresh,
    add,
    correct,
    onLive,
  };
}

export type HeadcountsState = ReturnType<typeof useHeadcounts>;
