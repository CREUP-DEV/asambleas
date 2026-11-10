<script setup lang="ts">
import type { ButtonProps } from "@nuxt/ui";
import type { DocumentSummaryDto } from "~~/shared/types/api";
import {
  isPendingProgress,
  type DocumentAudience,
} from "~/composables/document/documentProgress";
import { formatDateTime } from "~/utils/format";

/**
 * Where a document stands before publication, as a banner: the sentence
 * that says what happens next (useDocumentProgress) and, when the
 * Secretaría asked for a correction, its note quoted in full. Renders
 * nothing once the document is published, withdrawn or postponed.
 *
 * The title is announced politely when it changes (a live refresh after the
 * Secretaría validates the document or asks for a correction).
 */
const props = withDefaults(
  defineProps<{
    document: DocumentSummaryDto;
    /** Who is looking; derived from the signed-in user when omitted. */
    audience?: DocumentAudience;
    /** Buttons for the next step (e.g. "Volver a enviar"). */
    actions?: ButtonProps[];
    /**
     * The screen shows the text itself (the editor): "no text yet" says
     * nothing it does not, so it is left out unless a deadline goes with it.
     */
    textOnScreen?: boolean;
  }>(),
  { audience: undefined, actions: undefined, textOnScreen: false },
);

const { t, locale } = useI18n();

const progress = useDocumentProgress(
  () => props.document,
  () => props.audience,
);

const visible = computed(
  () =>
    isPendingProgress(progress.value.state) &&
    !(
      props.textOnScreen &&
      progress.value.state === "expected" &&
      progress.value.dueAt === null
    ),
);
const voice = computed(() =>
  progress.value.audience === "presenter" ? "presenter" : "manager",
);
const isCorrection = computed(() => progress.value.state === "correction");

const title = computed(() =>
  isCorrection.value
    ? t(`document.progress.banner.correctionTitle.${voice.value}`)
    : progress.value.sentence,
);

/** A deadline still ahead, for the countdown. */
const upcomingDue = computed(() =>
  progress.value.dueAt && !progress.value.overdue ? progress.value.dueAt : null,
);

const submittedOn = computed(() =>
  progress.value.state === "submitted" && props.document.submittedAt
    ? t("document.progress.banner.submittedOn", {
        date: formatDateTime(props.document.submittedAt, {
          locale: locale.value,
        }),
      })
    : null,
);

const hasDescription = computed(
  () => isCorrection.value || Boolean(upcomingDue.value || submittedOn.value),
);
</script>

<template>
  <UAlert
    v-if="visible"
    :color="progress.color"
    variant="subtle"
    :icon="progress.icon"
    :title="title"
    :actions="actions"
    data-testid="document-progress-banner"
  >
    <template #title>
      <span role="status" aria-live="polite">{{ title }}</span>
    </template>
    <template v-if="hasDescription" #description>
      <div class="space-y-2">
        <template v-if="isCorrection">
          <blockquote
            v-if="progress.note"
            class="border-warning/50 text-default border-s-2 ps-3 break-words whitespace-pre-line"
          >
            {{ progress.note }}
          </blockquote>
          <p>{{ t(`document.progress.banner.correctionHint.${voice}`) }}</p>
        </template>
        <p v-else-if="submittedOn">{{ submittedOn }}</p>
        <CommonCountdown
          v-if="upcomingDue"
          :to="upcomingDue"
          :label="t('document.progress.banner.dueCountdown')"
          :urgent-hours="48"
          icon="i-lucide-hourglass"
        />
      </div>
    </template>
  </UAlert>
</template>
