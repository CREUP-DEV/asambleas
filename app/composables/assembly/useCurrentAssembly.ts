import type { ComputedRef, InjectionKey, Ref } from "vue";
import type { AgendaDto, AssemblyDto, LiveEventDto } from "~~/shared/types/api";
import { APP_TIME_ZONE, intlLocale, toDate } from "~/utils/format";
import type { DateInput } from "~/utils/format";
import { keepLastGoodData, useStaleDataNotice } from "../fetch/lastGoodData";
import { shouldRefetchAgenda, shouldRefetchAssembly } from "./-liveFilters";

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
  /** State of the live stream. */
  live: {
    connected: Readonly<Ref<boolean>>;
    polling: Readonly<Ref<boolean>>;
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
  );

  function onLive(handler: AssemblyLiveHandler): () => void {
    handlers.add(handler);
    const off = () => {
      handlers.delete(handler);
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
    live: { connected: readonly(ref(false)), polling: readonly(ref(false)) },
  };
}

/**
 * The agenda of the current assembly (flat items plus visible documents),
 * shared by the overview, agenda and convocatoria pages under one key and
 * refreshed on live events. Awaitable, like useFetch.
 *
 * `data` keeps the last good agenda when a refresh fails (`stale` is then
 * true), so the tree and any dialog open on it stay. It stays writable for
 * optimistic updates and their rollbacks.
 */
export function useAssemblyAgenda() {
  const { assembly, apiBase, onLive } = useCurrentAssembly();
  const result = useFetch<AgendaDto>(() => `${apiBase.value}/agenda`, {
    key: computed(() => `assembly-agenda-${assembly.value?.id ?? "none"}`),
    dedupe: "defer",
  });
  const { data, stale } = keepLastGoodData(result, {
    resetOn: () => assembly.value?.id,
  });
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

/** "80.ª" in Spanish, "80th" in English. */
export function assemblyOrdinal(value: number, locale: string): string {
  if (locale.startsWith("en")) {
    const mod100 = value % 100;
    const suffix =
      mod100 >= 11 && mod100 <= 13
        ? "th"
        : (({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[
            value % 10
          ] ?? "th");
    return `${value}${suffix}`;
  }
  return `${value}.ª`;
}

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
