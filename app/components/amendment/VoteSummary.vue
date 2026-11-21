<script setup lang="ts">
import type { VoteDto } from "~~/shared/types/api";
import { shownVoteCounts, voteTextKey } from "~~/shared/utils/votes";
import { useAmendmentLinks } from "~/composables/amendment/amendmentLinks";
import { useAlternativesVoteText } from "~/composables/vote/useAlternativesVoteText";

/**
 * Result and counts of a recorded vote (on an amendment or the final text).
 * Abstentions, or blank ballots in a secret vote; invalid ones, those who
 * cast nothing and the members present only when recorded.
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
const alternativesText = useAlternativesVoteText();
/** A vote between alternatives: options instead of in favour and against. */
const alternatives = computed(() =>
  alternativesText.isAlternatives(props.vote),
);
const links = useAmendmentLinks();
function codeOf(id: string): string {
  return links?.get(id)?.code ?? "?";
}

const counts = computed(() => {
  const vote = props.vote;
  const rows: { key: string; value: number }[] = shownVoteCounts(vote);
  if (vote.present !== null) rows.push({ key: "present", value: vote.present });
  return rows;
});

const isAssent = computed(() => props.vote.method === "assent");
/**
 * How it was decided: the method, or "Por unanimidad" for an assent nobody
 * objected to when unanimity was asked.
 */
const methodLabel = computed(() =>
  isAssent.value && props.vote.unanimous
    ? t("amendment.vote.unanimous")
    : t(`amendment.vote.methods.${props.vote.method}`),
);

const summary = computed(() =>
  alternatives.value
    ? alternativesText.summary(props.vote)
    : isAssent.value
      ? methodLabel.value
      : t(voteTextKey("amendment.vote.inline", props.vote.method), {
          inFavor: props.vote.inFavor,
          against: props.vote.against,
          abstentions: props.vote.abstentions,
          blank: props.vote.blank,
        }),
);
</script>

<template>
  <div v-if="compact" class="flex flex-wrap items-center gap-2 text-sm">
    <CommonStatusBadge
      v-if="!alternatives"
      kind="vote"
      :value="vote.result"
      size="xs"
    />
    <span class="text-muted tabular-nums">{{ summary }}</span>
  </div>

  <div v-else class="space-y-3">
    <div class="flex flex-wrap items-center gap-2">
      <CommonStatusBadge
        v-if="!alternatives"
        kind="vote"
        :value="vote.result"
      />
      <span class="text-muted text-sm">
        <template v-if="alternatives">
          {{ t("amendment.vote.alternatives.title") }} ·
        </template>
        {{ methodLabel }}
        ·
        {{ t(`amendment.vote.majorities.${vote.majority}`) }}
      </span>
    </div>
    <!-- A vote between alternatives: each option, its amendments and votes,
         the winner marked; then what came of it. -->
    <template v-if="alternatives">
      <ul class="space-y-2">
        <li
          v-for="(option, index) in vote.options ?? []"
          :key="index"
          class="rounded-md border px-3 py-2"
          :class="
            vote.winningOption === index
              ? 'border-success bg-success/5'
              : 'border-default'
          "
        >
          <div class="flex items-center justify-between gap-3">
            <span class="text-highlighted font-semibold">
              {{ alternativesText.optionName(index) }}
            </span>
            <span class="text-highlighted text-lg font-semibold tabular-nums">
              {{ option.count }}
            </span>
          </div>
          <p class="text-muted text-sm">
            <AmendmentCodeLinks :ids="option.amendmentIds" :label-of="codeOf" />
          </p>
        </li>
      </ul>
      <p class="text-default text-sm">
        {{ alternativesText.outcome(vote) }}
      </p>
    </template>
    <dl
      v-if="!isAssent && !alternatives"
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
    <!-- A registered vote: what each delegation voted. -->
    <section v-if="vote.ballots && vote.ballots.length > 0" class="space-y-1">
      <h4 class="text-muted text-xs font-medium">
        {{ t("session.rollCall.title") }}
      </h4>
      <VoteBallots :vote="vote" />
    </section>
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
