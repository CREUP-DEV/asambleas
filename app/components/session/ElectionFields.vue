<script setup lang="ts">
import type { HeadcountDto } from "~~/shared/types/api";
import type { AssemblySettings } from "~~/shared/constants/domain";
import {
  computeElectionOutcome,
  ELECTION_CANDIDATE_MAX_LENGTH,
  ELECTION_MAX_CANDIDATES,
  type ElectionInput,
} from "~~/shared/utils/election";

/**
 * An election in an agenda item's vote (user's decisions of 2026-11-21):
 * the candidates, the posts (the most that may be elected), the most each
 * ballot may mark (not necessarily the posts), the rule (the
 * absolute majority with a second round, as the CAS and the CAI elect, or
 * a simple majority), each candidate's votes and the ballots that marked
 * someone (worked out with one post), then blank and invalid ballots in a
 * secret vote or abstentions by show of hands. The preview says who is
 * elected, or who goes to a second round.
 */
const props = defineProps<{
  settings: Pick<AssemblySettings, "denominator">;
  headcount?: HeadcountDto | null;
  /** Secret: blank and invalid ballots; otherwise abstentions. */
  secret: boolean;
}>();

const election = defineModel<ElectionInput>({ required: true });
const blank = defineModel<number>("blank", { required: true });
const invalid = defineModel<number>("invalid", { required: true });
const abstentions = defineModel<number>("abstentions", { required: true });

const { t } = useI18n();

function update(next: Partial<ElectionInput>): void {
  const merged = { ...election.value, ...next };
  // With one post, the ballots that marked someone are the votes.
  if (merged.maxChoices === 1) {
    merged.ballots = merged.counts.reduce((sum, value) => sum + value, 0);
  }
  election.value = merged;
}
function setCandidate(index: number, value: string): void {
  const candidates = [...election.value.candidates];
  candidates[index] = value;
  update({ candidates });
}
function addCandidate(): void {
  if (election.value.candidates.length >= ELECTION_MAX_CANDIDATES) return;
  update({
    candidates: [...election.value.candidates, ""],
    counts: [...election.value.counts, 0],
  });
}
function removeCandidate(index: number): void {
  if (election.value.candidates.length <= 1) return;
  const candidates = election.value.candidates.filter((_, at) => at !== index);
  update({
    candidates,
    counts: election.value.counts.filter((_, at) => at !== index),
    posts: Math.min(election.value.posts, candidates.length),
    maxChoices: Math.min(election.value.maxChoices, candidates.length),
  });
}
function setCount(index: number, value: number | null | undefined): void {
  const counts = [...election.value.counts];
  counts[index] = typeof value === "number" ? value : 0;
  update({ counts });
}

const outcome = computed(() =>
  computeElectionOutcome(
    election.value,
    {
      blank: props.secret ? blank.value : 0,
      invalid: props.secret ? invalid.value : 0,
      present: props.headcount?.present ?? null,
    },
    props.settings,
  ),
);
function names(indexes: number[]): string {
  return indexes
    .map((index) => election.value.candidates[index]?.trim() || "?")
    .join(", ");
}
const preview = computed(() => {
  const counted =
    election.value.counts.some((value) => value > 0) || blank.value > 0;
  if (!counted) return null;
  const result = outcome.value;
  if (result.inconsistent) return t("session.election.inconsistent");
  const parts: string[] = [];
  if (result.elected.length > 0) {
    parts.push(
      t(
        "session.election.elected",
        { names: names(result.elected) },
        result.elected.length,
      ),
    );
  }
  if (result.tie) parts.push(t("session.election.tie"));
  if (result.runoff) {
    parts.push(
      t("session.election.runoff", {
        names: names(result.runoff),
        threshold: result.threshold ?? 0,
      }),
    );
  }
  if (parts.length === 0) parts.push(t("session.election.nobody"));
  return parts.join(" · ");
});
</script>

<template>
  <div class="space-y-4">
    <fieldset class="space-y-2">
      <legend class="text-highlighted mb-1 text-sm font-medium">
        {{ t("session.election.candidates") }}
      </legend>
      <div
        v-for="(candidate, index) in election.candidates"
        :key="index"
        class="flex items-end gap-2"
      >
        <UFormField
          :label="t('session.election.candidate', { n: index + 1 })"
          class="min-w-0 flex-1"
        >
          <UInput
            :model-value="candidate"
            :maxlength="ELECTION_CANDIDATE_MAX_LENGTH"
            class="w-full"
            @update:model-value="(value) => setCandidate(index, String(value))"
          />
        </UFormField>
        <UFormField :label="t('session.election.votes')" class="w-28">
          <UInputNumber
            :model-value="election.counts[index] ?? 0"
            :min="0"
            :max="100000"
            class="w-full"
            @update:model-value="(value) => setCount(index, value)"
          />
        </UFormField>
        <UButton
          color="neutral"
          variant="ghost"
          icon="i-lucide-x"
          :aria-label="t('session.election.remove', { n: index + 1 })"
          :disabled="election.candidates.length <= 1"
          @click="removeCandidate(index)"
        />
      </div>
      <UButton
        size="sm"
        color="neutral"
        variant="outline"
        icon="i-lucide-plus"
        :label="t('session.election.add')"
        @click="addCandidate"
      />
    </fieldset>

    <div class="grid gap-3 sm:grid-cols-2">
      <UFormField
        :label="t('session.election.posts')"
        :help="t('session.election.postsHelp')"
      >
        <UInputNumber
          :model-value="election.posts"
          :min="1"
          :max="election.candidates.length"
          class="w-full"
          @update:model-value="
            (value) => update({ posts: Math.max(1, value ?? 1) })
          "
        />
      </UFormField>
      <UFormField
        :label="t('session.election.maxChoices')"
        :help="t('session.election.maxChoicesHelp')"
      >
        <UInputNumber
          :model-value="election.maxChoices"
          :min="1"
          :max="election.candidates.length"
          class="w-full"
          @update:model-value="
            (value) => update({ maxChoices: Math.max(1, value ?? 1) })
          "
        />
      </UFormField>
      <UFormField
        v-if="election.maxChoices > 1"
        :label="t('session.election.ballots')"
        :help="t('session.election.ballotsHelp')"
      >
        <UInputNumber
          :model-value="election.ballots"
          :min="0"
          :max="100000"
          class="w-full"
          @update:model-value="(value) => update({ ballots: value ?? 0 })"
        />
      </UFormField>
    </div>

    <URadioGroup
      :model-value="election.rule"
      :legend="t('session.election.rule')"
      :items="[
        {
          value: 'absolute_runoff',
          label: t('session.election.rules.absolute_runoff'),
          description: t('session.election.rules.absolute_runoffHint'),
        },
        {
          value: 'simple',
          label: t('session.election.rules.simple'),
          description: t('session.election.rules.simpleHint'),
        },
      ]"
      variant="card"
      :ui="{ fieldset: 'grid gap-2 sm:grid-cols-2' }"
      @update:model-value="
        (value) => update({ rule: value as ElectionInput['rule'] })
      "
    />

    <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <template v-if="secret">
        <UFormField :label="t('amendment.vote.blank')">
          <UInputNumber v-model="blank" :min="0" :max="100000" class="w-full" />
        </UFormField>
        <UFormField :label="t('amendment.vote.invalid')">
          <UInputNumber
            v-model="invalid"
            :min="0"
            :max="100000"
            class="w-full"
          />
        </UFormField>
      </template>
      <UFormField v-else :label="t('amendment.vote.abstentions')">
        <UInputNumber
          v-model="abstentions"
          :min="0"
          :max="100000"
          class="w-full"
        />
      </UFormField>
      <div class="border-default rounded-lg border px-3 py-2">
        <p class="text-muted text-xs">{{ t("session.vote.present") }}</p>
        <p class="text-highlighted text-lg font-semibold tabular-nums">
          {{ headcount?.present ?? "—" }}
        </p>
      </div>
    </div>

    <p
      v-if="preview"
      class="text-sm font-medium"
      :class="
        outcome.inconsistent || outcome.runoff || outcome.tie
          ? 'text-warning'
          : 'text-success'
      "
      aria-live="polite"
    >
      {{ preview }}
    </p>
  </div>
</template>
