<script setup lang="ts">
import type { VoteDto } from "~~/shared/types/api";

/**
 * Result and counts of a recorded vote (on an amendment or the final text).
 * Blank and invalid votes and the members present only show when recorded.
 */
const props = withDefaults(
  defineProps<{
    vote: VoteDto;
    /** One line, for cards and popovers. */
    compact?: boolean;
  }>(),
  { compact: false },
);

const { t, locale } = useI18n();

const counts = computed(() => {
  const vote = props.vote;
  const rows: { key: string; value: number }[] = [
    { key: "inFavor", value: vote.inFavor },
    { key: "against", value: vote.against },
    { key: "abstentions", value: vote.abstentions },
  ];
  if (vote.blank > 0) rows.push({ key: "blank", value: vote.blank });
  if (vote.invalid > 0) rows.push({ key: "invalid", value: vote.invalid });
  if (vote.present !== null) rows.push({ key: "present", value: vote.present });
  return rows;
});

const isAssent = computed(() => props.vote.method === "assent");

const summary = computed(() =>
  isAssent.value
    ? t("amendment.vote.methods.assent")
    : t("amendment.vote.inline", {
        inFavor: props.vote.inFavor,
        against: props.vote.against,
        abstentions: props.vote.abstentions,
      }),
);
</script>

<template>
  <div v-if="compact" class="flex flex-wrap items-center gap-2 text-sm">
    <CommonStatusBadge kind="vote" :value="vote.result" size="xs" />
    <span class="text-muted tabular-nums">{{ summary }}</span>
  </div>

  <div v-else class="space-y-3">
    <div class="flex flex-wrap items-center gap-2">
      <CommonStatusBadge kind="vote" :value="vote.result" />
      <span class="text-muted text-sm">
        {{ t(`amendment.vote.methods.${vote.method}`) }}
        ·
        {{ t(`amendment.vote.majorities.${vote.majority}`) }}
      </span>
    </div>
    <dl
      v-if="!isAssent"
      class="grid grid-cols-2 gap-2 sm:grid-cols-3"
      :aria-label="t('amendment.vote.counts')"
    >
      <div
        v-for="row in counts"
        :key="row.key"
        class="border-default rounded-md border px-3 py-2"
      >
        <dt class="text-muted text-xs">{{ t(`amendment.vote.${row.key}`) }}</dt>
        <dd class="text-highlighted text-lg font-semibold tabular-nums">
          {{ row.value }}
        </dd>
      </div>
    </dl>
    <p v-if="vote.note" class="text-muted text-sm whitespace-pre-line">
      {{ vote.note }}
    </p>
    <p class="text-dimmed text-xs">
      {{
        t("amendment.vote.recordedAt", {
          date: formatDateTime(vote.recordedAt, { locale }),
        })
      }}
    </p>
  </div>
</template>
