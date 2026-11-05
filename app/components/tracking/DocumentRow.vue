<script setup lang="ts">
import type { DocumentSummaryDto } from "~~/shared/types/api";
import { isPendingProgress } from "~/composables/document/documentProgress";

/**
 * One document of the tracking panel: what it is, who presents it (the main
 * presenter, then at most two co-presenters before "N más"), its
 * internal deadline and where it stands, as the Secretaría reads it
 * (useDocumentProgress). Drafts show their deadline on a line of its own;
 * an overdue one is marked with an icon and words, not only with colour. In
 * edit mode drafts offer "Cambiar plazo", or "Poner plazo" if they have none.
 */
const props = withDefaults(
  defineProps<{
    document: DocumentSummaryDto;
    /** Localized path of the document page. */
    to: string;
    editing?: boolean;
  }>(),
  { editing: false },
);

const emit = defineEmits<{ "edit-deadline": [] }>();

const { t, locale } = useI18n();
const now = useAppNow();

const progress = useDocumentProgress(() => props.document, "manager");
const isDraft = computed(() => props.document.status === "draft");
/**
 * The status sentence, unless it would only repeat the deadline line above
 * ("Esperando el texto. Fecha límite: …"): for a draft with a deadline the
 * chip and that line already say it all.
 */
const showSentence = computed(
  () =>
    isPendingProgress(progress.value.state) &&
    !(
      isDraft.value &&
      progress.value.dueAt &&
      (progress.value.state === "expected" ||
        progress.value.state === "preparing")
    ),
);

/** Correction notes longer than this start folded to three lines. */
const LONG_NOTE = 160;
const sentenceId = useId();
const noteLong = computed(() => (progress.value.note?.length ?? 0) > LONG_NOTE);
const sentenceOpen = ref(false);

/**
 * Overdue drafts say so in words: the badge does for those waited for or in
 * preparation; a correction keeps its own label, so the deadline line does.
 */
const overdueInLine = computed(
  () => progress.value.overdue && progress.value.state === "correction",
);

const SENTENCE_COLORS: Record<string, string> = {
  neutral: "text-muted",
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  error: "text-error",
};

function absolute(value: string | null): string {
  return formatDateTime(value, { locale: locale.value, style: "long" });
}

function relative(value: string | null): string {
  return value
    ? formatRelative(value, { locale: locale.value, now: now.value })
    : "";
}

/** The date worth showing once it left the presenter's hands. */
const when = computed<{ label: string; at: string } | null>(() => {
  const document = props.document;
  if (document.status === "submitted" && document.submittedAt) {
    return { label: t("tracking.row.sent"), at: document.submittedAt };
  }
  if (document.status === "published" && document.publishedAt) {
    return { label: t("tracking.row.publishedOn"), at: document.publishedAt };
  }
  return null;
});
</script>

<template>
  <div
    class="border-default flex flex-col gap-3 rounded-md border px-3 py-3 sm:flex-row sm:items-start sm:justify-between"
    :class="progress.overdue ? 'border-s-error border-s-4' : ''"
  >
    <div class="min-w-0 flex-1 space-y-1.5">
      <NuxtLink
        :to="props.to"
        class="text-highlighted focus-visible:outline-primary block min-w-0 rounded-sm font-medium hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <UIcon
          :name="
            document.format === 'file'
              ? 'i-lucide-file-text'
              : 'i-lucide-file-pen-line'
          "
          class="text-muted me-1 inline size-4 align-[-2px]"
          aria-hidden="true"
        />
        <span>{{ document.title }}</span>
        <span
          v-if="document.reference"
          class="text-muted ms-1.5 text-sm font-normal tabular-nums"
          >· {{ document.reference }}</span
        >
      </NuxtLink>

      <div
        class="text-muted flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
      >
        <span>{{ t(`agenda.documentKinds.${document.kind}`) }}</span>
        <span aria-hidden="true">·</span>
        <span class="inline-flex min-w-0 flex-wrap items-center gap-x-1.5">
          <span>{{ t("tracking.row.presenter") }}</span>
          <DocumentPresenters
            v-if="document.proponent"
            :document="document"
            :max-others="2"
            show-name
          />
          <span v-else class="text-warning font-medium">
            {{ t("tracking.row.noPresenter") }}
          </span>
        </span>
      </div>

      <p
        v-if="when"
        class="text-muted flex flex-wrap items-center gap-x-1.5 text-sm"
      >
        <UIcon
          name="i-lucide-calendar"
          class="size-4 shrink-0"
          aria-hidden="true"
        />
        <span>{{ when.label }}</span>
        <time :datetime="when.at" :title="absolute(when.at)">{{
          relative(when.at)
        }}</time>
      </p>

      <p
        v-if="isDraft && progress.dueAt"
        class="flex flex-wrap items-center gap-x-1.5 text-sm"
        :class="progress.overdue ? 'text-error font-medium' : 'text-muted'"
      >
        <UIcon
          :name="
            progress.overdue ? 'i-lucide-alarm-clock' : 'i-lucide-calendar'
          "
          class="size-4 shrink-0"
          aria-hidden="true"
        />
        <span>{{ t("tracking.row.deadline") }}</span>
        <time :datetime="progress.dueAt">{{ absolute(progress.dueAt) }}</time>
        <template v-if="overdueInLine">
          <span aria-hidden="true">·</span>
          <span>{{ t("tracking.row.overdue") }}</span>
        </template>
      </p>

      <div v-if="showSentence" class="space-y-0.5">
        <p
          class="flex items-start gap-1.5 text-sm"
          :class="SENTENCE_COLORS[progress.color]"
        >
          <UIcon
            :name="progress.icon"
            class="mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          <span
            :id="sentenceId"
            class="break-words whitespace-pre-line"
            :class="noteLong && !sentenceOpen ? 'line-clamp-3' : ''"
            >{{ progress.sentence }}</span
          >
        </p>
        <UButton
          v-if="noteLong"
          color="neutral"
          variant="link"
          size="xs"
          class="ms-5.5 px-0"
          :label="
            sentenceOpen
              ? t('tracking.row.showLess')
              : t('tracking.row.showMore')
          "
          :aria-expanded="sentenceOpen"
          :aria-controls="sentenceId"
          @click="sentenceOpen = !sentenceOpen"
        />
      </div>
    </div>

    <div class="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
      <UBadge
        :color="progress.color"
        variant="subtle"
        size="md"
        :icon="progress.overdue ? 'i-lucide-alarm-clock' : progress.icon"
        :label="progress.label"
        class="whitespace-nowrap"
      />
      <UButton
        v-if="editing && isDraft"
        color="neutral"
        variant="outline"
        size="sm"
        icon="i-lucide-calendar-cog"
        :label="
          document.dueAt
            ? t('tracking.row.changeDeadline')
            : t('tracking.row.setDeadline')
        "
        :aria-label="
          document.dueAt
            ? t('tracking.row.changeDeadlineFor', { title: document.title })
            : t('tracking.row.setDeadlineFor', { title: document.title })
        "
        @click="emit('edit-deadline')"
      />
    </div>
  </div>
</template>
