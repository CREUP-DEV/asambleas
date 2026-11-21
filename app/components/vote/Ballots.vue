<script setup lang="ts">
import type { VoteDto } from "~~/shared/types/api";
import type { VoteBallot } from "~~/shared/utils/rollCall";

/**
 * What each delegation voted in a registered vote (user's decision of
 * 2026-11-21), grouped by sense: «A favor (12): CEUM, CEUPV (vota CEUIB)…»,
 * then against, abstentions and those who did not vote; in a vote between
 * alternatives, each option first. Nothing for a vote without ballots.
 * `size` follows where it sits: the projection reads it from afar.
 */
const props = withDefaults(
  defineProps<{
    vote: Pick<VoteDto, "ballots" | "options">;
    size?: "sm" | "lg";
  }>(),
  { size: "sm" },
);

const { t } = useI18n();
const alternativesText = useAlternativesVoteText();

const groups = computed(() => {
  const ballots = props.vote.ballots ?? [];
  if (ballots.length === 0) return [];
  const optionCount = props.vote.options?.length ?? 0;
  const keys: {
    key: string;
    label: string;
    test: (b: VoteBallot) => boolean;
  }[] = [
    ...(optionCount > 0
      ? Array.from({ length: optionCount }, (_, index) => ({
          key: `option:${index}`,
          label: alternativesText.optionName(index),
          test: (ballot: VoteBallot) =>
            ballot.choice === "option" && ballot.option === index,
        }))
      : [
          {
            key: "in_favor",
            label: t("session.vote.inFavor"),
            test: (ballot: VoteBallot) => ballot.choice === "in_favor",
          },
          {
            key: "against",
            label: t("session.vote.against"),
            test: (ballot: VoteBallot) => ballot.choice === "against",
          },
        ]),
    {
      key: "abstention",
      label: t("session.vote.abstentions"),
      test: (ballot) => ballot.choice === "abstention",
    },
    {
      key: "not_voting",
      label: t("session.rollCall.notVoting"),
      test: (ballot) => ballot.choice === "not_voting",
    },
  ];
  return keys
    .map((group) => ({
      key: group.key,
      label: group.label,
      names: ballots.filter(group.test).map((ballot) =>
        ballot.delegate
          ? t("session.rollCall.nameVotedBy", {
              code: ballot.acronym,
              by: ballot.delegate.acronym,
            })
          : ballot.acronym,
      ),
    }))
    .filter((group) => group.names.length > 0);
});
</script>

<template>
  <dl
    v-if="groups.length > 0"
    :class="size === 'lg' ? 'space-y-1' : 'space-y-0.5 text-sm'"
    :aria-label="t('session.rollCall.title')"
  >
    <div v-for="group in groups" :key="group.key" class="leading-snug">
      <dt class="text-highlighted inline font-semibold">
        {{ group.label }} ({{ group.names.length }}):
      </dt>
      <dd class="text-default inline">{{ group.names.join(", ") }}</dd>
    </div>
  </dl>
</template>
