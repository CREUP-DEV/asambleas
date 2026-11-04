import type { Block } from "~~/shared/types/content";
import { errorStatus } from "../api/useApi";
import { useCurrentAssembly } from "../assembly/useCurrentAssembly";
import { useDocument } from "../document/useDocument";
import { useDocumentAmendments } from "./useDocumentAmendments";

/**
 * Data of the document workspace and the consolidated text page, inside the
 * assembly hub: the hub's assembly, the document of the `[document]` route
 * param (useDocument), its frozen base text and its amendments. Everything
 * stays fresh through the hub's single live stream.
 */
export function useDocumentWorkspace() {
  const route = useRoute();
  const hub = useCurrentAssembly();

  const assemblyParam = computed(() => String(route.params.assembly ?? ""));
  const documentParam = computed(() => String(route.params.document ?? ""));

  const {
    document,
    pending: documentPending,
    error: documentError,
    refresh: refreshDocument,
  } = useDocument(assemblyParam, documentParam);

  /** The frozen base the amendments anchor to (empty until publication). */
  const base = computed<Block[]>(
    () => document.value?.baseVersion?.blocks ?? [],
  );

  const amendments = useDocumentAmendments({
    // Route params keep the fetch key stable between SSR and hydration.
    assembly: assemblyParam,
    document: documentParam,
    assemblyId: () => hub.assembly.value?.id,
    documentId: () => document.value?.id,
  });

  /** Base url of the amendment API, by ids once the DTOs are loaded. */
  const amendmentsUrl = computed(() => {
    const assemblyId = hub.assembly.value?.id ?? assemblyParam.value;
    const documentId = document.value?.id ?? documentParam.value;
    return `/api/assemblies/${encodeURIComponent(assemblyId)}/documents/${encodeURIComponent(documentId)}/amendments`;
  });

  /** Localized path of a page of this document ("" = the workspace). */
  function documentPath(page = ""): string {
    const slug = document.value?.slug ?? documentParam.value;
    const path = `documentos/${encodeURIComponent(slug)}`;
    return hub.sectionPath(page ? `${path}/${page}` : path);
  }

  const pending = computed(() => documentPending.value && !document.value);
  const errorStatusCode = computed(() => errorStatus(documentError.value));

  async function refreshAll(): Promise<void> {
    await Promise.all([refreshDocument(), amendments.refresh()]);
  }

  return {
    hub,
    assembly: hub.assembly,
    assemblyParam,
    documentParam,
    document,
    base,
    amendments,
    amendmentsUrl,
    documentPath,
    pending,
    error: documentError,
    errorStatusCode,
    refreshDocument,
    refreshAll,
  };
}

export type DocumentWorkspace = ReturnType<typeof useDocumentWorkspace>;
