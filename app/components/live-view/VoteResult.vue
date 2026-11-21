<script setup lang="ts">
import type { VoteDto } from "~~/shared/types/api";
import { liveAssentKey, liveVoteCounts } from "~/components/live-view/-model";

/**
 * The last vote the Mesa recorded, for the live view: what was voted (and,
 * for an agenda item, what the Mesa wrote it decided), the result in large
 * type and the counts (or "por asentimiento", "por unanimidad").
 */
const props = withDefaults(
  defineProps<{
    vote: VoteDto;
    /** What was voted, already localized ("Votación de la enmienda T1"). */
    subject: string;
    /** What an agenda item's vote decided (liveVoteQuestion), if anything. */
    question?: string | null;
  }>(),
  { question: null },
);

const { t } = useI18n();
const alternativesText = useAlternativesVoteText();
/** A vote between alternatives: each option's votes, the winner named. */
const alternatives = computed(() =>
  alternativesText.isAlternatives(props.vote),
);

const approved = computed(() => props.vote.result === "approved");
const counts = computed(() => liveVoteCounts(props.vote));
const assentKey = computed(() => liveAssentKey(props.vote));
</script>

<template>
  <div
    class="rounded-lg border-s-4 p-4"
    :class="
      approved ? 'border-success bg-success/10' : 'border-error bg-error/10'
    "
  >
    <p class="text-muted text-sm">
      {{ alternatives ? t("amendment.vote.alternatives.title") : subject }}
    </p>
    <p
      v-if="question"
      class="text-highlighted mt-0.5 font-medium whitespace-pre-line"
    >
      {{ question }}
    </p>
    <p
      class="text-2xl font-bold"
      :class="
        approved
          ? 'text-(--ui-color-success-800) dark:text-(--ui-color-success-300)'
          : 'text-(--ui-color-error-700) dark:text-(--ui-color-error-300)'
      "
    >
      <template v-if="alternatives">
        {{ alternativesText.outcome(vote) }}
      </template>
      <template v-else>
        {{
          approved
            ? t("projection.vote.approved")
            : t("projection.vote.rejected")
        }}
      </template>
    </p>
    <dl v-if="alternatives" class="mt-2 flex flex-wrap gap-x-6 gap-y-2">
      <div v-for="(option, index) in vote.options ?? []" :key="index">
        <dt class="text-muted text-xs">
          {{ alternativesText.optionName(index) }}
        </dt>
        <dd class="text-highlighted text-lg font-semibold tabular-nums">
          {{ option.count }}
        </dd>
      </div>
      <div v-for="count in counts" :key="count.key">
        <dt class="text-muted text-xs">
          {{ t(`projection.vote.${count.key}`) }}
        </dt>
        <dd class="text-highlighted text-lg font-semibold tabular-nums">
          {{ count.value }}
        </dd>
      </div>
    </dl>
    <p v-else-if="assentKey" class="text-default mt-1">
      {{ t(assentKey) }}
    </p>
    <dl v-else class="mt-2 flex flex-wrap gap-x-6 gap-y-2">
      <div v-for="count in counts" :key="count.key">
        <dt class="text-muted text-xs">
          {{ t(`projection.vote.${count.key}`) }}
        </dt>
        <dd class="text-highlighted text-lg font-semibold tabular-nums">
          {{ count.value }}
        </dd>
      </div>
      <div>
        <dt class="text-muted text-xs">{{ t("projection.vote.majority") }}</dt>
        <dd class="text-default text-sm font-medium">
          {{ t(`session.enums.majority.${vote.majority}`) }}
        </dd>
      </div>
    </dl>
    <!-- A registered vote: what each delegation voted. -->
    <VoteBallots
      v-if="vote.ballots && vote.ballots.length > 0"
      :vote="vote"
      class="mt-3"
    />
  </div>
</template>
