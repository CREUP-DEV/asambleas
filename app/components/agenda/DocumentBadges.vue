<script setup lang="ts">
import type { DocumentSummaryDto } from "~~/shared/types/api";
import { isPendingProgress } from "~/composables/document/documentProgress";
import { unreadAmendmentsPath } from "~/composables/document/documentLinks";

/**
 * What the agenda says of a document at a glance: its status (once published,
 * only to its presenters: useDocumentStatusShown), whether
 * the account has read it (ReadMark), how many amendments it has, in words
 * ("4 enmiendas"), how many of them are left to read (a link to the
 * document's page with only those listed, given `to`), and, for the
 * presenter's own draft (`editTo`), the next step as a button. Used by the compact document
 * row and by an agenda item that shows its only document in its own row.
 */
const props = withDefaults(
  defineProps<{
    document: DocumentSummaryDto;
    /** The editor of the user's own draft, for the call to action. */
    editTo?: string | null;
    /** The document's page, so «N sin leer» opens it with only those listed. */
    to?: string | null;
  }>(),
  { editTo: null, to: null },
);

const { t } = useI18n();

const progress = useDocumentProgress(() => props.document);
const pending = computed(() => isPendingProgress(progress.value.state));
const callToAction = computed(() =>
  props.editTo && progress.value.actionLabel
    ? progress.value.actionLabel
    : null,
);

const showStatus = useDocumentStatusShown(() => props.document);
const marks = useReadMarks();
const mark = computed(() => marks.document(props.document.id));
/** Amendments to it the account still has to read. */
const amendmentsLeft = computed(
  () => marks.index.value.amendmentsLeft.get(props.document.id) ?? 0,
);

const showAmendments = computed(
  () =>
    !pending.value &&
    (props.document.amendable || props.document.amendmentCount > 0),
);
</script>

<template>
  <div class="flex shrink-0 flex-wrap items-center gap-1.5">
    <UBadge
      v-if="pending"
      :color="progress.color"
      variant="subtle"
      size="md"
      :label="progress.label"
    />
    <CommonStatusBadge
      v-else-if="showStatus"
      kind="document"
      :value="document.status"
    />
    <ReadMark
      v-if="!pending"
      kind="document"
      :state="mark?.state"
      :own="mark?.own"
    />
    <UBadge
      v-if="showAmendments"
      color="neutral"
      variant="soft"
      size="md"
      icon="i-lucide-message-square-diff"
      class="tabular-nums"
      :label="
        t(
          'agenda.document.amendments',
          { count: document.amendmentCount },
          document.amendmentCount,
        )
      "
      data-testid="document-amendment-count"
    />
    <NuxtLink
      v-if="amendmentsLeft > 0 && to"
      :to="unreadAmendmentsPath(to)"
      class="focus-visible:outline-primary inline-flex rounded-md hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2"
      data-testid="document-amendments-left"
    >
      <UBadge
        color="primary"
        variant="subtle"
        size="md"
        class="tabular-nums"
        :label="
          t(
            'readMarks.amendmentsHere',
            { count: amendmentsLeft },
            amendmentsLeft,
          )
        "
      />
    </NuxtLink>
    <UBadge
      v-else-if="amendmentsLeft > 0"
      color="primary"
      variant="subtle"
      size="md"
      class="tabular-nums"
      :label="
        t('readMarks.amendmentsHere', { count: amendmentsLeft }, amendmentsLeft)
      "
      data-testid="document-amendments-left"
    />
    <UButton
      v-if="callToAction && editTo"
      :to="editTo"
      size="xs"
      :color="progress.state === 'correction' ? 'warning' : 'primary'"
      trailing-icon="i-lucide-arrow-right"
      :label="callToAction"
      :aria-label="`${callToAction}: ${document.title}`"
    />
  </div>
</template>
