import type { InjectionKey, MaybeRefOrGetter, Ref } from "vue";
import type {
  ControlSheetDocumentObservationsDto,
  ControlSheetObservationDto,
} from "~~/shared/types/api";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";

/**
 * The control sheet's observations about the document on show and its
 * amendments (GET .../control-sheet/documents/[document]), for whoever
 * reads the sheet, so they read them on the document's page as they read
 * their private notes (user's decision of 2026-11-17). The document page
 * provides them once; the notes panel and the amendment's detail inject
 * them. Nothing for anyone else, and nothing outside that page.
 */
export interface SheetObservationsContext {
  observations: Readonly<Ref<ControlSheetDocumentObservationsDto | null>>;
  amendment: (id: string) => ControlSheetObservationDto | null;
  refresh: () => Promise<void>;
}

const SHEET_OBSERVATIONS_KEY: InjectionKey<SheetObservationsContext> =
  Symbol("sheet-observations");

export function provideSheetObservations(
  documentId: MaybeRefOrGetter<string | null | undefined>,
): SheetObservationsContext {
  const api = useApi();
  const { can } = useMe();
  const { apiBase, onLive } = useCurrentAssembly();
  const readsSheet = computed(
    () =>
      can(PERMISSION_KEYS.CONTROL_SHEET_VIEW) ||
      can(PERMISSION_KEYS.CONTROL_SHEET_EDIT) ||
      can(PERMISSION_KEYS.SESSION_RECORD_SPEAKERS),
  );
  const url = computed(() => {
    const id = toValue(documentId);
    return id && readsSheet.value
      ? `${apiBase.value}/control-sheet/documents/${encodeURIComponent(id)}`
      : null;
  });

  const { data, refresh: reload } = useAsyncData(
    () => `sheet-observations-${url.value ?? "none"}`,
    async () =>
      url.value
        ? await api.get<ControlSheetDocumentObservationsDto>(url.value)
        : null,
    { server: false, lazy: true, watch: [url], default: () => null },
  );

  // Someone wrote in the sheet: the stream never says about what.
  onLive((events) => {
    if (
      url.value &&
      events.some(
        (event) =>
          event.type === "poll" || event.entityType === "control_sheet",
      )
    ) {
      void reload();
    }
  });

  const context: SheetObservationsContext = {
    observations: computed(() => data.value ?? null),
    amendment: (id) =>
      data.value?.amendments.find((row) => row.amendmentId === id) ?? null,
    refresh: async () => {
      await reload();
    },
  };
  provide(SHEET_OBSERVATIONS_KEY, context);
  return context;
}

/** The sheet's observations the page provides, or null outside it. */
export function useSheetObservations(): SheetObservationsContext | null {
  return inject(SHEET_OBSERVATIONS_KEY, null);
}
