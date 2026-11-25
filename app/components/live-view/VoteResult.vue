<script setup lang="ts">
import type { AmendmentDto, VoteDto } from "~~/shared/types/api";
import {
  liveAssentKey,
  liveVoteAmendments,
  liveVoteCounts,
} from "~/components/live-view/-model";

/**
 * The last vote the Mesa recorded, for the live view: what was voted (and,
 * for an agenda item, what the Mesa wrote it decided), the result in large
 * type and the counts (or "por asentimiento", "por unanimidad"). A bloc
 * names its amendments («Votación en bloque: UM1, UM3 y UM7») and each
 * alternative lists its own under its votes, as codes that open the page's
 * amendment window (AmendmentCodeLinks).
 */
const props = withDefaults(
  defineProps<{
    vote: VoteDto;
    /** What was voted, already localized ("Votación de la enmienda T1"). */
    subject: string;
    /** What an agenda item's vote decided (liveVoteQuestion), if anything. */
    question?: string | null;
    /**
     * The amendments the reader reads, for the codes of a bloc or of each
     * alternative; one it lacks is left out.
     */
    amendments?: readonly Pick<AmendmentDto, "id" | "code" | "number">[];
  }>(),
  { question: null, amendments: () => [] },
);

const { t } = useI18n();
const alternativesText = useAlternativesVoteText();
/** A vote between alternatives: each option's votes, the winner named. */
const alternatives = computed(() =>
  alternativesText.isAlternatives(props.vote),
);

const electionText = useElectionText();

/** A bloc's amendments and each alternative's, by the codes the reader has. */
const groups = computed(() => liveVoteAmendments(props.vote, props.amendments));
const codes = computed(
  () =>
    new Map(
      [
        ...(groups.value.bloc ?? []),
        ...(groups.value.options ?? []).flat(),
      ].map((item) => [item.id, item.code]),
    ),
);
const codeOf = (id: string) => codes.value.get(id) ?? "";
const idsOf = (items: readonly { id: string }[]) =>
  items.map((item) => item.id);

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
      <template v-if="alternatives">
        {{ t("amendment.vote.alternatives.title") }}
      </template>
      <template v-else-if="groups.bloc">
        {{ t("amendment.vote.bloc")
        }}<template v-if="groups.bloc.length > 0"
          >: <AmendmentCodeLinks :ids="idsOf(groups.bloc)" :label-of="codeOf"
        /></template>
      </template>
      <template v-else>{{ subject }}</template>
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
      <template v-else-if="vote.election">
        {{ electionText.outcome(vote.election) }}
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
      <div
        v-for="(option, index) in vote.options ?? []"
        :key="index"
        class="max-w-full min-w-0"
      >
        <dt class="text-muted text-xs">
          {{ alternativesText.optionName(index) }}
        </dt>
        <dd class="text-highlighted text-lg font-semibold tabular-nums">
          {{ option.count }}
        </dd>
        <!-- Its amendments, under its votes. -->
        <dd
          v-if="groups.options?.[index]?.length"
          class="text-muted text-sm break-words"
        >
          <AmendmentCodeLinks
            :ids="idsOf(groups.options?.[index] ?? [])"
            :label-of="codeOf"
          />
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
    <div v-else-if="vote.election" class="mt-2 space-y-2">
      <VoteElection :election="vote.election" />
      <dl class="flex flex-wrap gap-x-6 gap-y-2">
        <div v-for="count in counts" :key="count.key">
          <dt class="text-muted text-xs">
            {{ t(`projection.vote.${count.key}`) }}
          </dt>
          <dd class="text-highlighted text-lg font-semibold tabular-nums">
            {{ count.value }}
          </dd>
        </div>
      </dl>
    </div>
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
