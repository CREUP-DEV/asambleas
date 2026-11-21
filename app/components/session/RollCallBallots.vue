<script setup lang="ts">
import type {
  RollCallChoice,
  RollCallVoter,
  VoteBallotInput,
} from "~~/shared/utils/rollCall";

/**
 * A registered vote called delegation by delegation (user's decision of
 * 2026-11-21): one row per voter at the latest headcount, in its order (a
 * delegated one says who votes for it), with what it votes. The counts
 * come from these rows. `choices` are what a delegation may vote: in
 * favour, against, abstention and «No vota», or, in a vote between
 * alternatives, each option, abstention and «No vota». A row left unmarked
 * does not vote. «Todos …» marks every row at once, to correct after.
 */
const props = defineProps<{
  voters: RollCallVoter[];
  choices: { choice: RollCallChoice; option?: number; label: string }[];
}>();

const ballots = defineModel<VoteBallotInput[]>({ required: true });

const { t } = useI18n();

function key(choice: RollCallChoice, option?: number | null): string {
  return choice === "option" ? `option:${option ?? 0}` : choice;
}

const byMember = computed(
  () =>
    new Map(
      ballots.value.map((ballot) => [
        ballot.memberId,
        key(ballot.choice, ballot.option),
      ]),
    ),
);

function choose(
  memberId: string,
  entry: { choice: RollCallChoice; option?: number },
): void {
  const rest = ballots.value.filter((ballot) => ballot.memberId !== memberId);
  ballots.value = [
    ...rest,
    {
      memberId,
      choice: entry.choice,
      ...(entry.choice === "option" ? { option: entry.option ?? 0 } : {}),
    },
  ];
}

function chooseAll(entry: { choice: RollCallChoice; option?: number }): void {
  ballots.value = props.voters.map((voter) => ({
    memberId: voter.memberId,
    choice: entry.choice,
    ...(entry.choice === "option" ? { option: entry.option ?? 0 } : {}),
  }));
}

/** How many rows each choice has, unmarked ones as «No vota». */
const totals = computed(() =>
  props.choices.map((entry) => {
    const wanted = key(entry.choice, entry.option);
    const count = props.voters.filter((voter) => {
      const marked = byMember.value.get(voter.memberId) ?? "not_voting";
      return marked === wanted;
    }).length;
    return { label: entry.label, count };
  }),
);
const unmarked = computed(
  () =>
    props.voters.filter((voter) => !byMember.value.has(voter.memberId)).length,
);
</script>

<template>
  <div class="space-y-2">
    <div class="flex flex-wrap items-center gap-2">
      <span class="text-muted text-xs">{{ t("session.rollCall.all") }}</span>
      <UButton
        v-for="entry in choices.filter((item) => item.choice !== 'not_voting')"
        :key="key(entry.choice, entry.option)"
        size="xs"
        color="neutral"
        variant="outline"
        :label="entry.label"
        @click="chooseAll(entry)"
      />
    </div>
    <ul
      class="border-default divide-default max-h-80 divide-y overflow-y-auto rounded-lg border"
      :aria-label="t('session.rollCall.title')"
    >
      <li
        v-for="voter in voters"
        :key="voter.memberId"
        class="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 text-sm"
      >
        <span class="min-w-0">
          <span class="text-highlighted font-medium">{{ voter.acronym }}</span>
          <span v-if="voter.delegate" class="text-muted text-xs">
            ·
            {{
              t("session.rollCall.votedBy", { code: voter.delegate.acronym })
            }}
          </span>
        </span>
        <UFieldGroup size="xs">
          <UButton
            v-for="entry in choices"
            :key="key(entry.choice, entry.option)"
            :label="entry.label"
            :color="
              byMember.get(voter.memberId) === key(entry.choice, entry.option)
                ? entry.choice === 'against'
                  ? 'error'
                  : entry.choice === 'in_favor' || entry.choice === 'option'
                    ? 'primary'
                    : 'neutral'
                : 'neutral'
            "
            :variant="
              byMember.get(voter.memberId) === key(entry.choice, entry.option)
                ? 'solid'
                : 'outline'
            "
            :aria-pressed="
              byMember.get(voter.memberId) === key(entry.choice, entry.option)
            "
            :aria-label="`${voter.acronym}: ${entry.label}`"
            @click="choose(voter.memberId, entry)"
          />
        </UFieldGroup>
      </li>
    </ul>
    <p class="text-muted text-xs tabular-nums" aria-live="polite">
      {{ totals.map((item) => `${item.label} ${item.count}`).join(" · ") }}
      <template v-if="unmarked > 0">
        · {{ t("session.rollCall.unmarked", { count: unmarked }, unmarked) }}
      </template>
    </p>
  </div>
</template>
