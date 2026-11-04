<script setup lang="ts">
import type { DocumentSummaryDto } from "~~/shared/types/api";
import { isWindowOpen } from "~~/shared/utils/calendar";

/**
 * One document under an agenda item: title and reference linking to the
 * document, status, kind, proponent, amendment count and the countdown of
 * its amendment window.
 */
const props = defineProps<{
  document: DocumentSummaryDto;
  to: string;
}>();

const { t } = useI18n();

// The shared clock, so a window that opens or closes while the page is open
// changes state without waiting for a refetch.
const now = useAppNow();

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
      <div class="text-muted flex flex-wrap items-center gap-1.5 text-xs">
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
    </div>

    <div
      class="relative z-[1] flex shrink-0 flex-wrap items-center gap-1.5 sm:justify-end"
    >
      <CommonMemberBadge
        v-if="document.proponent"
        :member="document.proponent"
      />
      <CommonStatusBadge kind="document" :value="document.status" />
      <UBadge
        v-if="document.consolidated"
        color="success"
        variant="outline"
        size="sm"
        icon="i-lucide-badge-check"
        :label="t('agenda.document.consolidated')"
      />
      <UTooltip
        v-if="document.amendable || document.amendmentCount > 0"
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
    </div>
  </div>
</template>
