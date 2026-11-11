import type { ComputedRef, InjectionKey, Ref } from "vue";
import type {
  ReadMarkAmendmentDto,
  ReadMarkDocumentDto,
  ReadMarksBody,
  ReadMarksDto,
} from "~~/shared/types/api";
import {
  indexReadMarks,
  readProgress,
  type ReadMarkIndex,
  type ReadProgress,
} from "~~/shared/utils/readMarks";
import type { CurrentAssemblyContext } from "../assembly/useCurrentAssembly";
import { keepLastGoodData } from "../fetch/lastGoodData";

/**
 * The account's read marks in the assembly on show: what it marked as read
 * among the published documents and amendments, and what is left. The hub
 * fetches them once (provideReadMarks) and every page and row under it reads
 * the same state (useReadMarks).
 *
 * Client only: the marks never delay the page, and what they add (a dot, a
 * count, a button) shows once they arrive. Outside the hub there are none.
 */

export interface ReadMarksContext {
  /** Null until they first load. */
  marks: Readonly<Ref<ReadMarksDto | null>>;
  index: ComputedRef<ReadMarkIndex>;
  progress: ComputedRef<ReadProgress>;
  /** The mark of a document or an amendment; null when it takes none. */
  document: (id: string) => ReadMarkDocumentDto | null;
  amendment: (id: string) => ReadMarkAmendmentDto | null;
  /** A request is on its way. */
  saving: Readonly<Ref<boolean>>;
  /** Marks as read, or as not read. False when it could not be saved. */
  set: (
    targets: Omit<ReadMarksBody, "read">,
    read: boolean,
  ) => Promise<boolean>;
}

const READ_MARKS_KEY: InjectionKey<ReadMarksContext> = Symbol("read-marks");

const EMPTY_INDEX = indexReadMarks(null);
const EMPTY_PROGRESS = readProgress(null);

/**
 * Called once by the assembly hub with the context it just provided (a
 * component does not inject what it provides itself).
 */
export function provideReadMarks(
  current: Pick<CurrentAssemblyContext, "assembly" | "apiBase" | "onLive">,
): ReadMarksContext {
  const { assembly, apiBase, onLive } = current;
  const api = useApi();

  const url = computed(() => `${apiBase.value}/read-marks`);
  const result = useFetch<ReadMarksDto>(url, {
    key: computed(() => `read-marks-${assembly.value?.id ?? "none"}`),
    server: false,
    lazy: true,
    immediate: Boolean(assembly.value),
    dedupe: "defer",
  });
  const { data } = keepLastGoodData(result, {
    resetOn: () => assembly.value?.id,
  });
  // `immediate` is read once: start when the assembly arrives later.
  watch(
    () => assembly.value?.id,
    (id) => {
      if (id && result.status.value === "idle") void result.execute();
    },
  );

  // What can be marked, and whether it changed, follows the documents and
  // the amendments.
  onLive((events) => {
    if (
      events.some(
        (event) =>
          event.type === "poll" ||
          event.entityType === "document" ||
          event.entityType === "amendment",
      )
    ) {
      void result.refresh({ dedupe: "defer" });
    }
  });

  const marks = computed<ReadMarksDto | null>(() => data.value ?? null);
  const index = computed(() => indexReadMarks(marks.value));
  const progress = computed(() => readProgress(marks.value));
  const saving = ref(false);

  async function set(
    targets: Omit<ReadMarksBody, "read">,
    read: boolean,
  ): Promise<boolean> {
    saving.value = true;
    try {
      data.value = await api.send<ReadMarksDto>(url.value, {
        method: "PUT",
        body: { ...targets, read } satisfies ReadMarksBody,
      });
      return true;
    } catch (error) {
      api.notifyError(error, "readMarks.error");
      // Something it named is gone or no longer published: read them again.
      void result.refresh({ dedupe: "defer" });
      return false;
    } finally {
      saving.value = false;
    }
  }

  const context: ReadMarksContext = {
    marks,
    index,
    progress,
    document: (id) => index.value.documents.get(id) ?? null,
    amendment: (id) => index.value.amendments.get(id) ?? null,
    saving: readonly(saving),
    set,
  };
  provide(READ_MARKS_KEY, context);
  return context;
}

/** The read marks of the assembly on show; none outside its hub. */
export function useReadMarks(): ReadMarksContext {
  const injected = inject(READ_MARKS_KEY, null);
  if (injected) return injected;
  return {
    marks: readonly(ref(null)),
    index: computed(() => EMPTY_INDEX),
    progress: computed(() => EMPTY_PROGRESS),
    document: () => null,
    amendment: () => null,
    saving: readonly(ref(false)),
    set: async () => false,
  };
}
