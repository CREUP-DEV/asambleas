import type { InjectionKey, MaybeRefOrGetter, Ref } from "vue";
import type {
  ControlSheetDocumentObservationsDto,
  ControlSheetObservationDto,
  LiveEventDto,
} from "~~/shared/types/api";
import { readsControlSheet } from "~~/shared/constants/permissions";

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

/**
 * Whether a batch of live events may change the observations shown: only
 * someone writing them (`control_sheet_observations_updated`, from the sheet
 * or added from an amendment's notes; clearing them too), never
 * the treated mark, the listing or a result noted by hand, which they do
 * not carry. "poll" (the stream was down) always does. The stream never
 * says which document a sheet row is about (only ids: the row, not its
 * subject), so any document's observations count.
 */
export function affectsSheetObservations(
  events: readonly Pick<LiveEventDto, "type">[],
): boolean {
  return events.some(
    (event) =>
      event.type === "poll" ||
      event.type === "control_sheet_observations_updated",
  );
}

export function provideSheetObservations(
  documentId: MaybeRefOrGetter<string | null | undefined>,
): SheetObservationsContext {
  const api = useApi();
  const { can } = useMe();
  const { apiBase, onLive } = useCurrentAssembly();
  // canViewControlSheet on the server: the same keys, declared once.
  const readsSheet = computed(() => readsControlSheet(can));
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

  onLive((events) => {
    if (url.value && affectsSheetObservations(events)) void reload();
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
