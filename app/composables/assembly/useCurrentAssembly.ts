import type { ComputedRef, InjectionKey, Ref } from "vue";
import type {
  AgendaDto,
  AssemblyDto,
  LiveEventDto,
  LiveScrollDto,
} from "~~/shared/types/api";
import { agendaWithTitles } from "~/utils/agendaTitles";
import { APP_TIME_ZONE, intlLocale, toDate } from "~/utils/format";
import type { DateInput } from "~/utils/format";
import { keepLastGoodData, useStaleDataNotice } from "../fetch/lastGoodData";
import { shouldRefetchAgenda, shouldRefetchAssembly } from "./-liveFilters";

/**
 * Up to how long a reader's page waits before refetching after a live
 * change (useAssemblyLive's spreadMs; user's decision of 2026-11-20).
 */
const LIVE_SPREAD_MS = 1_200;

/**
 * The assembly shown by the hub page (app/pages/asambleas/[assembly].vue)
 * and shared with every nested section page through provide/inject.
 *
 * The hub fetches the AssemblyDto once, keeps the single live (SSE)
 * connection of the assembly, and fans its events out to the section pages
 * that subscribe with `onLive`. Section pages must not open their own
 * `useAssemblyLive` stream: one per tab is enough.
 *
 * A failed refresh never takes the assembly away once it has loaded: the
 * last good DTO stays (see keepLastGoodData), so the open section, its
 * dialogs and unsaved input survive, and the live stream stays connected.
 */

export type AssemblyLiveHandler = (events: LiveEventDto[]) => void;
export type AssemblyScrollHandler = (scroll: LiveScrollDto) => void;

export interface CurrentAssemblyContext {
  /**
   * The loaded assembly; null only until it first loads, or when it is
   * gone (404). A failed refresh keeps the last good DTO.
   */
  assembly: Readonly<Ref<AssemblyDto | null>>;
  /** True while the last refresh failed and the last good DTO is shown. */
  stale: Readonly<Ref<boolean>>;
  /** Canonical slug ("80-ago"), or the route param until the DTO loads. */
  slug: ComputedRef<string>;
  /** "/api/assemblies/<id>" (the route param until the DTO loads). */
  apiBase: ComputedRef<string>;
  /** Localized path of the hub: "/asambleas/80-ago" or "/en/asambleas/80-ago". */
  basePath: ComputedRef<string>;
  /** Localized path of a section: sectionPath("calendario"). */
  sectionPath: (section?: string) => string;
  pending: Readonly<Ref<boolean>>;
  /** Refetches the AssemblyDto. */
  refresh: () => Promise<void>;
  /** Replaces the cached assembly with the DTO a mutation returned. */
  setAssembly: (dto: AssemblyDto) => void;
  /**
   * Subscribes to the live events of this assembly, already debounced and
   * deduplicated (see useAssemblyLive). Unsubscribes automatically when the
   * calling component is disposed; also returns the unsubscribe function.
   */
  onLive: (handler: AssemblyLiveHandler) => () => void;
  /**
   * Subscribes to where the Mesa has the document in debate scrolled (the
   * stream's `scroll` events), as onLive: the live view follows it.
   */
  onLiveScroll: (handler: AssemblyScrollHandler) => () => void;
  /** State of the live stream. */
  live: {
    connected: Readonly<Ref<boolean>>;
    polling: Readonly<Ref<boolean>>;
    /** The session is gone: the stream stopped (useAssemblyLive). */
    expired: Readonly<Ref<boolean>>;
  };
}

export const CURRENT_ASSEMBLY_KEY: InjectionKey<CurrentAssemblyContext> =
  Symbol("current-assembly");

/** useState key holding the current assembly for the layout and others. */
export const CURRENT_ASSEMBLY_STATE_KEY = "current-assembly";

export interface ProvideCurrentAssemblyOptions {
  /** The fetched DTO (the `data` ref of useFetch). */
  data: Ref<AssemblyDto | null | undefined>;
  /** The `status` and `error` refs of the same useFetch. */
  status: Readonly<Ref<string>>;
  error: Readonly<Ref<unknown>>;
  pending: Readonly<Ref<boolean>>;
  refresh: () => Promise<void>;
  /** The `[assembly]` route param (slug or id). */
  routeParam: () => string;
  /** Called when the assembly is deleted while it is open. */
  onDeleted?: () => void;
}

/**
 * Called once by the hub page, synchronously in setup (after its own
 * `await useFetch`). Opens the live stream and provides the context.
 */
export function provideCurrentAssembly(
  options: ProvideCurrentAssemblyOptions,
): CurrentAssemblyContext {
  const localePath = useLocalePath();
  const shared = useState<AssemblyDto | null>(
    CURRENT_ASSEMBLY_STATE_KEY,
    () => null,
  );

  // The route param never changes for a mounted hub (another assembly
  // mounts another hub); the reset only guards against reusing one.
  const lastGood = keepLastGoodData(
    { data: options.data, status: options.status, error: options.error },
    { resetOn: options.routeParam },
  );
  useStaleDataNotice(lastGood.stale);

  const assembly = computed<AssemblyDto | null>(
    () => lastGood.data.value ?? null,
  );
  const slug = computed(
    () => assembly.value?.slug ?? options.routeParam() ?? "",
  );
  const apiBase = computed(
    () =>
      `/api/assemblies/${encodeURIComponent(assembly.value?.id ?? options.routeParam())}`,
  );
  const basePath = computed(() =>
    localePath(`/asambleas/${encodeURIComponent(slug.value)}`),
  );
  const sectionPath = (section?: string) =>
    section ? `${basePath.value}/${section}` : basePath.value;

  watch(
    assembly,
    (value) => {
      shared.value = value;
    },
    { immediate: true },
  );
  onBeforeUnmount(() => {
    // Going from one assembly to another mounts the new hub first: only
    // clear the shared state if it still holds this hub's assembly.
    if (!shared.value || shared.value.id === assembly.value?.id) {
      shared.value = null;
    }
  });

  const handlers = new Set<AssemblyLiveHandler>();
  const scrollHandlers = new Set<AssemblyScrollHandler>();

  // Keyed on the kept assembly, so a failed refresh never closes the stream.
  const live = useAssemblyLive(
    () => assembly.value?.id,
    (events) => {
      if (events.some((event) => event.type === "assembly_deleted")) {
        options.onDeleted?.();
        return;
      }
      // Speaking turns and the live state leave the DTO as it is.
      if (shouldRefetchAssembly(events)) void options.refresh();
      for (const handler of handlers) {
        try {
          handler(events);
        } catch (error) {
          console.error("[assembly] live handler failed", error);
        }
      }
    },
    {
      onScroll: (scroll) => {
        for (const handler of scrollHandlers) handler(scroll);
      },
      // The room spreads its refetches over a second; the Mesa, whose
      // console must follow at once, never waits.
      spreadMs: () => (assembly.value?.can.moderate ? 0 : LIVE_SPREAD_MS),
    },
  );

  function onLive(handler: AssemblyLiveHandler): () => void {
    handlers.add(handler);
    const off = () => {
      handlers.delete(handler);
    };
    if (getCurrentScope()) onScopeDispose(off);
    return off;
  }

  function onLiveScroll(handler: AssemblyScrollHandler): () => void {
    scrollHandlers.add(handler);
    const off = () => {
      scrollHandlers.delete(handler);
    };
    if (getCurrentScope()) onScopeDispose(off);
    return off;
  }

  const context: CurrentAssemblyContext = {
    assembly,
    stale: lastGood.stale,
    slug,
    apiBase,
    basePath,
    sectionPath,
    pending: options.pending,
    refresh: options.refresh,
    setAssembly: (dto) => {
      lastGood.data.value = dto;
    },
    onLive,
    onLiveScroll,
    live,
  };
  provide(CURRENT_ASSEMBLY_KEY, context);
  return context;
}

/**
 * The current assembly. Inside the hub's nested pages it is the hub's
 * context; anywhere else (e.g. the layout) it falls back to a read-only view
 * of the shared state, with no live events.
 */
export function useCurrentAssembly(): CurrentAssemblyContext {
  const injected = inject(CURRENT_ASSEMBLY_KEY, null);
  if (injected) return injected;

  const localePath = useLocalePath();
  const shared = useState<AssemblyDto | null>(
    CURRENT_ASSEMBLY_STATE_KEY,
    () => null,
  );
  const assembly = computed(() => shared.value);
  const slug = computed(() => shared.value?.slug ?? "");
  const basePath = computed(() =>
    localePath(`/asambleas/${encodeURIComponent(slug.value)}`),
  );
  return {
    assembly,
    stale: readonly(ref(false)),
    slug,
    apiBase: computed(
      () => `/api/assemblies/${encodeURIComponent(shared.value?.id ?? "")}`,
    ),
    basePath,
    sectionPath: (section?: string) =>
      section ? `${basePath.value}/${section}` : basePath.value,
    pending: readonly(ref(false)),
    refresh: async () => {},
    setAssembly: (dto) => {
      shared.value = dto;
    },
    onLive: () => () => {},
    onLiveScroll: () => () => {},
    live: {
      connected: readonly(ref(false)),
      polling: readonly(ref(false)),
      expired: readonly(ref(false)),
    },
  };
}

/**
 * useState key of the assemblies (by id) whose shared agenda a page kept
 * without following every event the agenda pages follow (Directo): the
 * next useAssemblyAgenda refetches it in the background.
 */
const AGENDA_BEHIND_STATE_KEY = "assembly-agenda-behind";

/**
 * The one fetch of the current assembly's agenda, under one key per
 * assembly. Every page that reads the agenda must go through it: the first
 * caller's handler serves every later refresh of the key, so a second
 * definition (another url, a handler that answers null) would leak into
 * the other pages.
 */
function useAgendaFetch(immediate: boolean) {
  const { assembly, apiBase } = useCurrentAssembly();
  return useFetch<AgendaDto>(() => `${apiBase.value}/agenda`, {
    key: computed(() => `assembly-agenda-${assembly.value?.id ?? "none"}`),
    dedupe: "defer",
    immediate,
  });
}

/** What a page that keeps the shared agenda does with a live batch. */
export type SharedAgendaAction = "refresh" | "behind" | "none";

/**
 * For a page that keeps the shared agenda (useSharedAgendaFetch) but
 * refetches it only on its own, narrower filter (`follows`), and only while
 * `active`: refetch when both hold; otherwise, when its filter or the agenda
 * pages' (shouldRefetchAgenda) would have refetched, mark the agenda behind,
 * so the next agenda page does it instead of showing stale counts.
 */
export function sharedAgendaAction(
  events: readonly LiveEventDto[],
  options: {
    follows: (events: readonly LiveEventDto[]) => boolean;
    active: boolean;
  },
): SharedAgendaAction {
  const own = options.follows(events);
  if (own && options.active) return "refresh";
  return own || shouldRefetchAgenda(events) ? "behind" : "none";
}

/**
 * Whether a mark of "behind" means anything for the shared agenda fetch in
 * this state: only while it holds an agenda or has a request in flight,
 * which the next agenda page would take over. With neither, that page
 * fetches the agenda anew, so marking it would only add a second request.
 */
export function agendaCanFallBehind(status: string, held: boolean): boolean {
  return held || status === "pending";
}

/** When useAssemblyAgenda refetches an agenda marked behind. */
export type BehindAgendaRefresh = "now" | "after-pending" | "none";

/**
 * When useAssemblyAgenda refetches an agenda marked behind, by the status
 * of the shared fetch it was handed: at once when it holds a good agenda;
 * once the request in flight settles when there is one, since it may have
 * left before the event that set the mark (fail open: that may be the
 * page's own first request, and then the refetch is one too many);
 * otherwise never.
 */
export function behindAgendaRefresh(status: string): BehindAgendaRefresh {
  if (status === "success") return "now";
  return status === "pending" ? "after-pending" : "none";
}

/**
 * The raw fetch behind useAssemblyAgenda, for a page that keeps the agenda
 * with its own live filter and its own stale state (Directo, which shows
 * only the title of the item in debate and must not make every phone
 * refetch the agenda when an amendment is published). Sharing the key lets
 * Directo and the agenda and document pages hand each other the agenda
 * already downloaded instead of fetching it again on every move between
 * them; call it without awaiting, and without `lazy`, which would refetch
 * an agenda just handed over.
 *
 * `immediate: false` fetches nothing until `result.refresh()` (unless
 * another page already holds the agenda). `markBehind` records that the
 * page let through an event the agenda pages follow (sharedAgendaAction),
 * unless the fetch holds nothing to fall behind (agendaCanFallBehind).
 */
export function useSharedAgendaFetch(options: { immediate?: boolean } = {}) {
  const { assembly } = useCurrentAssembly();
  const behind = useState<Record<string, true>>(
    AGENDA_BEHIND_STATE_KEY,
    () => ({}),
  );
  const result = useAgendaFetch(options.immediate ?? true);
  function markBehind(): void {
    const id = assembly.value?.id;
    if (!id || behind.value[id]) return;
    const held = result.data.value !== undefined && result.data.value !== null;
    if (!agendaCanFallBehind(result.status.value, held)) return;
    behind.value = { ...behind.value, [id]: true };
  }
  return { result, markBehind };
}

/**
 * The agenda of the current assembly (flat items plus visible documents),
 * shared under one key by the overview, agenda, follow-up, documents and
 * convocatoria pages, the document's breadcrumb and reading bar, and
 * Directo (useSharedAgendaFetch), and refreshed on live events
 * (shouldRefetchAgenda). Awaitable, like useFetch: an agenda another page
 * still holds is used at once, without a request.
 *
 * `data` keeps the last good agenda when a refresh fails (`stale` is then
 * true), so the tree and any dialog open on it stay. It stays writable for
 * optimistic updates and their rollbacks.
 */
export function useAssemblyAgenda() {
  const { assembly, onLive } = useCurrentAssembly();
  const { t } = useI18n();
  const result = useAgendaFetch(true);
  const { data: fetched, stale } = keepLastGoodData(result, {
    resetOn: () => assembly.value?.id,
  });
  if (import.meta.client) {
    // Directo kept this agenda without following some event this page
    // follows (an amendment published or withdrawn changes the counts):
    // show it at once and refetch it in the background. The awaitable
    // above already resolved, so the page does not wait for it. Only after
    // keepLastGoodData has seen the agenda handed over as good, so a
    // refetch that fails keeps it on screen (stale) instead of wiping it.
    const behind = useState<Record<string, true>>(
      AGENDA_BEHIND_STATE_KEY,
      () => ({}),
    );
    const id = assembly.value?.id;
    if (id && behind.value[id]) {
      behind.value = Object.fromEntries(
        Object.entries(behind.value).filter(([key]) => key !== id),
      ) as Record<string, true>;
      const when = behindAgendaRefresh(result.status.value);
      if (when === "now") {
        void result.refresh();
      } else if (when === "after-pending") {
        const stop = watch(result.status, (status) => {
          if (status === "pending") return;
          stop();
          void result.refresh();
        });
      }
    }
  }
  // An item sent without its title gets a neutral one (titleHidden).
  const data = agendaWithTitles(fetched, () => t("agenda.hiddenTitle"));
  useStaleDataNotice(stale);
  onLive((events) => {
    if (shouldRefetchAgenda(events)) void result.refresh();
  });
  const agenda = {
    data,
    stale,
    pending: result.pending,
    status: result.status,
    error: result.error,
    refresh: result.refresh,
    execute: result.execute,
    clear: result.clear,
  };
  return Object.assign(
    Promise.resolve(result).then(() => agenda),
    agenda,
  );
}

// Formatting --------------------------------------------------------------

/**
 * "14–16 de noviembre de 2026", or a single date when both fall on the same
 * day, always in the assemblies' time zone.
 */
export function formatAssemblyDateRange(
  start: DateInput,
  end: DateInput,
  locale: string,
): string {
  const from = toDate(start);
  const to = toDate(end) ?? from;
  if (!from || !to) return "";
  const formatter = new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone: APP_TIME_ZONE,
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const sameDay = formatter.format(from) === formatter.format(to);
  if (sameDay || typeof formatter.formatRange !== "function") {
    return sameDay
      ? formatter.format(from)
      : `${formatter.format(from)} – ${formatter.format(to)}`;
  }
  // ICU versions differ in the spaces around the range dash (thin or
  // narrow no-break spaces), so the server and the browser would render
  // different strings and break hydration.
  return formatter.formatRange(from, to).replace(/[\u2009\u202f]/g, " ");
}
