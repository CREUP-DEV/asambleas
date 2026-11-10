<script setup lang="ts">
import type { DocumentSummaryDto } from "~~/shared/types/api";
import { isPendingProgress } from "~/composables/document/documentProgress";

/**
 * What the agenda says of a document at a glance: its status, how many
 * amendments it has, in words ("4 enmiendas"), and, for the presenter's own
 * draft (`editTo`), the next step as a button. Used by the compact document
 * row and by an agenda item that shows its only document in its own row.
 */
const props = withDefaults(
  defineProps<{
    document: DocumentSummaryDto;
    /** The editor of the user's own draft, for the call to action. */
    editTo?: string | null;
  }>(),
  { editTo: null },
);

const { t } = useI18n();

const progress = useDocumentProgress(() => props.document);
const pending = computed(() => isPendingProgress(progress.value.state));
const callToAction = computed(() =>
  props.editTo && progress.value.actionLabel
    ? progress.value.actionLabel
    : null,
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
      size="sm"
      :label="progress.label"
    />
    <CommonStatusBadge v-else kind="document" :value="document.status" />
    <UBadge
      v-if="showAmendments"
      color="neutral"
      variant="soft"
      size="sm"
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
