import type { MaybeRefOrGetter } from "vue";
import type { DocumentSummaryDto } from "~~/shared/types/api";
import { showsDocumentStatus } from "./documentPresenters";

/**
 * Whether the viewer reads the status badge of a document
 * (showsDocumentStatus): "Publicado" is only for its presenters.
 */
export function useDocumentStatusShown(
  document: MaybeRefOrGetter<DocumentSummaryDto>,
) {
  const me = useMe();
  return computed(() =>
    showsDocumentStatus(toValue(document), me.member.value?.id),
  );
}
