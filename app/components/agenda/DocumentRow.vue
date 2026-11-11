<script setup lang="ts">
import type { DocumentSummaryDto } from "~~/shared/types/api";
import { isWindowOpen } from "~~/shared/utils/calendar";
import { isPendingProgress } from "~/composables/document/documentProgress";

/**
 * One document under an agenda item: title and reference linking to the
 * document, kind, who presents it ("CEUM con UPV", at most two co-presenters
 * before "N más"), amendment count and the countdown of its amendment
 * window.
 *
 * Once published its status badge is only for its presenters
 * (useDocumentStatusShown); everyone gets whether the account
 * has read it (ReadMark) and how many of its amendments are left to read.
 *
 * Before publication it also says, in a sentence, where the document stands
 * and what comes next (useDocumentProgress). With `editTo` (the presenter's
 * own draft) it offers the next step: prepare it, keep working on it or fix
 * it and send it again.
 *
 * `compact` (the agenda page) keeps only what is needed to find a document
 * and see how it stands: format icon, title, status, the amendment count in
 * words and that call to action (AgendaDocumentBadges). Presenters, the
 * window countdown and the progress sentence are left out.
 */
const props = withDefaults(
  defineProps<{
    document: DocumentSummaryDto;
    to: string;
    /** The editor of the user's own draft, for the call to action. */
    editTo?: string | null;
    compact?: boolean;
  }>(),
  { editTo: null, compact: false },
);

const { t } = useI18n();

// The shared clock, so a window that opens or closes while the page is open
// changes state without waiting for a refetch.
const now = useAppNow();

const progress = useDocumentProgress(() => props.document);
const pending = computed(() => isPendingProgress(progress.value.state));
const callToAction = computed(() =>
  props.editTo && progress.value.actionLabel
    ? progress.value.actionLabel
    : null,
);

/** Whether the document has an amendment window (as the server computes it). */
const hasWindow = computed(
  () =>
    props.document.amendable &&
    props.document.status === "published" &&
    props.document.format === "structured",
);

/**
 * Whether the amendment window is open right now. `window.open` is the
 * server's answer at fetch time; for a document with a window it is exactly
 * `isWindowOpen` over its dates, so it is recomputed against the clock (no
 * live event fires when a window opens or closes on time).
 */
const openNow = computed(() => {
  const { open, opensAt, closesAt } = props.document.window;
  if (!hasWindow.value) return open;
  return isWindowOpen(
    {
      opensAt: opensAt ? new Date(opensAt) : null,
      closesAt: closesAt ? new Date(closesAt) : null,
    },
    new Date(now.value),
  );
});

/** The window countdown worth showing, if any. */
const windowCountdown = computed<{ label: string; at: string } | null>(() => {
  if (!hasWindow.value) return null;
  const { opensAt, closesAt } = props.document.window;
  if (openNow.value && closesAt && new Date(closesAt).getTime() > now.value) {
    return { label: t("agenda.document.windowCloses"), at: closesAt };
  }
  if (!openNow.value && opensAt && new Date(opensAt).getTime() > now.value) {
    return { label: t("agenda.document.windowOpens"), at: opensAt };
  }
  return null;
});

const showStatus = useDocumentStatusShown(() => props.document);
const marks = useReadMarks();
const mark = computed(() => marks.document(props.document.id));
/** Amendments to it the account still has to read. */
const amendmentsLeft = computed(
  () => marks.index.value.amendmentsLeft.get(props.document.id) ?? 0,
);

const amendmentsLabel = computed(() =>
  t(
    "agenda.document.amendments",
    { count: props.document.amendmentCount },
    props.document.amendmentCount,
  ),
);

const windowClosed = computed(
  () => hasWindow.value && !openNow.value && !windowCountdown.value,
);

const SENTENCE_COLORS: Record<string, string> = {
  neutral: "text-muted",
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  error: "text-error",
};
</script>

<template>
  <div
    class="border-default hover:bg-elevated/50 focus-within:bg-elevated/50 group relative flex flex-col gap-2 rounded-md border px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
  >
    <div class="min-w-0 space-y-1">
      <NuxtLink
        :to="props.to"
        class="text-highlighted focus-visible:outline-primary block min-w-0 font-medium after:absolute after:inset-0 after:rounded-md hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <UIcon
          :name="
            document.format === 'file'
              ? 'i-lucide-file-text'
              : 'i-lucide-file-pen-line'
          "
          class="text-muted me-1 inline size-4 align-middle"
          aria-hidden="true"
        />
        <span>{{ document.title }}</span>
        <span
          v-if="document.reference"
          class="text-muted text-sm font-normal tabular-nums"
        >
          · {{ document.reference }}</span
        >
      </NuxtLink>
      <div
        v-if="!compact"
        class="text-muted flex flex-wrap items-center gap-1.5 text-xs"
      >
        <span>{{ t(`agenda.documentKinds.${document.kind}`) }}</span>
        <template v-if="document.format === 'file'">
          <span aria-hidden="true">·</span>
          <span>{{ t("agenda.formats.file") }}</span>
        </template>
        <template v-if="windowCountdown">
          <span aria-hidden="true">·</span>
          <CommonCountdown
            :to="windowCountdown.at"
            :label="windowCountdown.label"
            icon="i-lucide-timer"
            :urgent-hours="48"
          />
        </template>
        <template v-else-if="windowClosed">
          <span aria-hidden="true">·</span>
          <span class="inline-flex items-center gap-1">
            <UIcon name="i-lucide-lock" class="size-3.5" aria-hidden="true" />
            {{ t("agenda.document.windowClosed") }}
          </span>
        </template>
      </div>
      <!-- Where it stands and what comes next (before publication) -->
      <p
        v-if="pending && !compact"
        class="flex items-start gap-1.5 text-sm"
        :class="SENTENCE_COLORS[progress.color]"
        data-testid="document-progress"
      >
        <UIcon
          :name="progress.icon"
          class="mt-0.5 size-4 shrink-0"
          aria-hidden="true"
        />
        <span class="line-clamp-3 break-words">{{ progress.sentence }}</span>
      </p>
    </div>

    <AgendaDocumentBadges
      v-if="compact"
      :document="document"
      :edit-to="editTo"
      class="relative z-[1] sm:justify-end"
    />
    <div
      v-else
      class="relative z-[1] flex shrink-0 flex-wrap items-center gap-1.5 sm:justify-end"
    >
      <DocumentPresenters :document="document" :max-others="2" />
      <UBadge
        v-if="pending"
        :color="progress.color"
        variant="subtle"
        size="sm"
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
        v-if="document.consolidated"
        color="success"
        variant="outline"
        size="sm"
        icon="i-lucide-badge-check"
        :label="t('agenda.document.consolidated')"
      />
      <UTooltip
        v-if="!pending && (document.amendable || document.amendmentCount > 0)"
        :text="amendmentsLabel"
      >
        <UBadge
          color="neutral"
          variant="soft"
          size="sm"
          icon="i-lucide-message-square-diff"
        >
          <span aria-hidden="true">{{ document.amendmentCount }}</span>
          <span class="sr-only">{{ amendmentsLabel }}</span>
        </UBadge>
      </UTooltip>
      <UBadge
        v-if="amendmentsLeft > 0"
        color="primary"
        variant="subtle"
        size="sm"
        class="tabular-nums"
        :label="
          t(
            'readMarks.amendmentsHere',
            { count: amendmentsLeft },
            amendmentsLeft,
          )
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
  </div>
</template>
