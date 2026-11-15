import type { Ref } from "vue";
import type {
  SeatingPlanDto,
  SeatingSourceResultDto,
  SeatingSyncResultDto,
} from "~~/shared/types/api";
import { affectsSeating, syncDue } from "~/components/seating/-model";
import { keepLastGoodData, useStaleDataNotice } from "../fetch/lastGoodData";
import { useCurrentAssembly } from "../assembly/useCurrentAssembly";

/**
 * The room of the open assembly (GET .../seating) for the Sala page: the
 * plan with its last good value kept through failed refreshes, the reads
 * of the Intranet's attendees («Sincronizar», and once on opening when the
 * last read is over ten minutes old, for editors only), the source of
 * those attendees, and a debounced refetch on the room's live events (the
 * hub ignores them: IGNORED_LIVE_ENTITIES).
 */

/** Live events come in bursts (a batch of seats, images arriving). */
const LIVE_REFETCH_DEBOUNCE_MS = 400;

export interface SeatingSyncOutcome {
  result: SeatingSyncResultDto | null;
  error: unknown;
}

/**
 * Call from setup, then `await` its `ready` there (never inside this
 * composable: its hooks must register before the first await).
 */
export function useSeatingPlan(options: {
  /** seating:view or seating:edit, and an assembly with a room. */
  allowed: Readonly<Ref<boolean>>;
}) {
  const api = useApi();
  const { assembly, apiBase, onLive } = useCurrentAssembly();

  const planFetch = useFetch<SeatingPlanDto>(() => `${apiBase.value}/seating`, {
    key: computed(() => `seating-${assembly.value?.id ?? "none"}`),
    immediate: options.allowed.value,
    dedupe: "defer",
  });
  const { data: plan, stale } = keepLastGoodData(planFetch, {
    resetOn: () => assembly.value?.id,
  });
  useStaleDataNotice(stale);

  function refresh(): void {
    if (!options.allowed.value) return;
    void planFetch.refresh({ dedupe: "defer" });
  }

  const refreshSoon = useDebounceFn(refresh, LIVE_REFETCH_DEBOUNCE_MS);
  onLive((events) => {
    if (affectsSeating(events)) void refreshSoon();
  });

  // The Intranet ----------------------------------------------------------------

  const syncing = ref(false);

  /** Reads the Intranet's attendees; the server throttles to one a minute. */
  async function sync(): Promise<SeatingSyncOutcome> {
    if (syncing.value) return { result: null, error: null };
    syncing.value = true;
    try {
      const result = await api.send<SeatingSyncResultDto>(
        `${apiBase.value}/seating/sync`,
        { method: "POST" },
      );
      plan.value = result.plan;
      return { result, error: null };
    } catch (error) {
      return { result: null, error };
    } finally {
      syncing.value = false;
    }
  }

  // Once per visit, on the client: editors only, and only when the last
  // read is old. A failure stays quiet: the line says how the last read went.
  onMounted(() => {
    const current = plan.value;
    if (!current?.can.edit) return;
    if (!syncDue(current.sync.at, Date.now())) return;
    void sync();
  });

  /**
   * Reads the attendees of another assembly (null: its own). The server
   * compares `expected` with what it holds, so two editors never undo each
   * other; then the next read runs at once.
   */
  async function setSource(sourceAssemblyId: string | null): Promise<void> {
    const current = plan.value;
    await api.send<SeatingSourceResultDto>(`${apiBase.value}/seating/source`, {
      method: "PUT",
      body: {
        sourceAssemblyId,
        expected: current?.sourceAssemblyId ?? null,
      },
    });
    if (current) {
      plan.value = {
        ...current,
        sourceAssemblyId,
        sync: { status: null, at: null, eventName: null },
      };
    }
    await sync();
  }

  return {
    /** Await it in the page's setup: the first load, on the server too. */
    ready: planFetch.then(() => undefined),
    plan,
    stale,
    pending: planFetch.pending,
    error: planFetch.error,
    refresh,
    sync,
    syncing: readonly(syncing),
    setSource,
  };
}
