import type { ComputedRef, MaybeRefOrGetter } from "vue";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type { DocumentSummaryDto } from "~~/shared/types/api";
import { formatDateTime } from "~/utils/format";
import {
  documentAudience,
  documentProgress,
  type DocumentAudience,
  type DocumentProgress,
} from "./documentProgress";

export interface DocumentProgressText extends DocumentProgress {
  audience: DocumentAudience;
  /** Short label for a badge ("Enviado a Secretaría"). */
  label: string;
  /** The sentence that says what happens next. */
  sentence: string;
  /** Label of the presenter's call to action, if any. */
  actionLabel: string | null;
}

/**
 * The plain-language status of a document for the signed-in user (see
 * `documentProgress`). The audience comes from `useMe` unless given: the
 * Secretaría (document:manage) first, then the presenting member.
 * Re-evaluated on the shared clock, so a deadline turns overdue on time.
 */
export function useDocumentProgress(
  document: MaybeRefOrGetter<DocumentSummaryDto>,
  audience?: MaybeRefOrGetter<DocumentAudience | undefined>,
): ComputedRef<DocumentProgressText> {
  const { t, locale } = useI18n();
  const me = useMe();
  const now = useAppNow();

  return computed(() => {
    const current = toValue(document);
    const resolved =
      toValue(audience) ??
      documentAudience(current, {
        memberId: me.member.value?.id,
        manager: me.can(PERMISSION_KEYS.DOCUMENT_MANAGE),
      });
    const progress = documentProgress(current, resolved, now.value);
    const date = progress.dueAt
      ? formatDateTime(progress.dueAt, { style: "long", locale: locale.value })
      : "";
    return {
      ...progress,
      audience: resolved,
      label: t(progress.labelKey),
      sentence: t(progress.sentenceKey, { date, note: progress.note ?? "" }),
      actionLabel: progress.action
        ? t(`document.progress.action.${progress.action}`)
        : null,
    };
  });
}
