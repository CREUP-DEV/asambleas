import type { ComputedRef, InjectionKey, Ref } from "vue";
import type { AgendaDto, AssemblyDto, LiveEventDto } from "~~/shared/types/api";
import { APP_TIME_ZONE, intlLocale, toDate } from "~/utils/format";
import type { DateInput } from "~/utils/format";

/**
 * The assembly shown by the hub page (app/pages/asambleas/[assembly].vue)
 * and shared with every nested section page through provide/inject.
 *
 * The hub fetches the AssemblyDto once, keeps the single live (SSE)
 * connection of the assembly, and fans its events out to the section pages
 * that subscribe with `onLive`. Section pages must not open their own
 * `useAssemblyLive` stream: one per tab is enough.
 */

export type AssemblyLiveHandler = (events: LiveEventDto[]) => void;

export interface CurrentAssemblyContext {
  /** The loaded assembly; null only while loading or after an error. */
  assembly: Readonly<Ref<AssemblyDto | null>>;
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

/** Event types that do not change anything a hub section shows. */
const IGNORED_LIVE_TYPES = new Set(["live_changed"]);

/** Live events that may change the AssemblyDto itself. */
function touchesAssembly(event: LiveEventDto): boolean {
  return (
    event.type === "poll" ||
    event.entityType === "assembly" ||
    // documentCount and nextMilestone depend on documents.
    event.entityType === "document"
  );
}

export interface ProvideCurrentAssemblyOptions {
  /** The fetched DTO (the `data` ref of useFetch). */
  data: Ref<AssemblyDto | null | undefined>;
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

  const assembly = computed<AssemblyDto | null>(
    () => options.data.value ?? null,
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

  const live = useAssemblyLive(
    () => assembly.value?.id,
    (events) => {
      if (events.some((event) => event.type === "assembly_deleted")) {
        options.onDeleted?.();
        return;
      }
      const relevant = events.filter(
        (event) => !IGNORED_LIVE_TYPES.has(event.type),
      );
      if (relevant.some(touchesAssembly)) void options.refresh();
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
    slug,
    apiBase,
    basePath,
    sectionPath,
    pending: options.pending,
    refresh: options.refresh,
    setAssembly: (dto) => {
      options.data.value = dto;
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
 */
export function useAssemblyAgenda() {
  const { assembly, apiBase, onLive } = useCurrentAssembly();
  const result = useFetch<AgendaDto>(() => `${apiBase.value}/agenda`, {
    key: computed(() => `assembly-agenda-${assembly.value?.id ?? "none"}`),
    dedupe: "defer",
  });
  onLive((events) => {
    if (events.some((event) => !IGNORED_LIVE_TYPES.has(event.type))) {
      void result.refresh();
    }
  });
  return result;
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
  return formatter.formatRange(from, to);
}
