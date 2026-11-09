<script setup lang="ts">
import type { VoteInput } from "~~/shared/types/api";
import {
  DECISION_METHODS,
  type DecisionMethod,
} from "~~/shared/constants/domain";
import {
  isSessionVoteReady,
  sessionAdmissionCandidates,
  sessionCleanVote,
  sessionEmptyVote,
  sessionVoteOutcome,
  type SessionAdmissionDecision,
} from "~/composables/session/sessionModel";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";

/**
 * Admits amendments or declares them inadmissible, one by one or in bulk:
 * late amendments pending admission, an on-time amendment the Mesa finds
 * inadmissible, or an inadmissible one to re-admit after a mistake. The
 * decision is recorded with its method (Mesa, Secretaría, assent or a vote
 * with its counts) and an optional note.
 */
const session = useSessionConsoleContext();
const { t } = useI18n();

const open = computed({
  get: () => session.admissionDialog.open,
  set: (value: boolean) => {
    session.admissionDialog.open = value;
  },
});

const selected = ref<string[]>([]);
const decision = ref<SessionAdmissionDecision>("admitted");
const method = ref<DecisionMethod>("mesa");
const note = ref("");
const vote = ref<VoteInput>(sessionEmptyVote("simple"));

/** Pending admission plus what the dialog was opened for, if eligible. */
const candidates = computed(() =>
  sessionAdmissionCandidates(
    session.amendments.value,
    decision.value,
    session.admissionDialog.ids,
  ),
);
/**
 * Ticked amendments the current decision applies to. Switching the decision
 * keeps the ticks, so switching back restores them.
 */
const chosen = computed(() => {
  const available = new Set(candidates.value.map((amendment) => amendment.id));
  return selected.value.filter((id) => available.has(id));
});

watch(open, (isOpen) => {
  if (!isOpen) return;
  // The decision first: the candidates depend on it.
  decision.value = session.admissionDialog.decision;
  selected.value = [...session.admissionDialog.ids];
  method.value = "mesa";
  note.value = "";
  vote.value = sessionEmptyVote("simple", session.votePresent.value);
});

const allSelected = computed(
  () =>
    candidates.value.length > 0 &&
    chosen.value.length === candidates.value.length,
);

function toggleAll(value: boolean | "indeterminate"): void {
  selected.value =
    value === true ? candidates.value.map((amendment) => amendment.id) : [];
}

function toggle(id: string, value: boolean | "indeterminate"): void {
  selected.value =
    value === true
      ? [...new Set([...selected.value, id])]
      : selected.value.filter((other) => other !== id);
}

const decisionItems = computed(() => [
  { label: t("session.admission.admit"), value: "admitted" },
  { label: t("session.admission.reject"), value: "inadmissible" },
]);
const methodItems = computed(() =>
  DECISION_METHODS.map((value) => ({
    label: t(`session.enums.decisionMethod.${value}`),
    value,
  })),
);

const outcome = computed(() =>
  sessionVoteOutcome(vote.value, session.settings.value),
);
const blocked = computed(
  () =>
    chosen.value.length === 0 ||
    (method.value === "vote" && !isSessionVoteReady(vote.value, outcome.value)),
);

async function submit(): Promise<void> {
  if (blocked.value) return;
  const ok = await session.decideAdmission({
    amendmentIds: chosen.value,
    decision: decision.value,
    method: method.value,
    note: note.value.trim() || null,
    vote: method.value === "vote" ? sessionCleanVote(vote.value) : null,
  });
  if (ok) open.value = false;
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="
      decision === 'admitted'
        ? t('session.admission.titleAdmit')
        : t('session.admission.titleInadmit')
    "
    :description="t('session.admission.description')"
    :ui="{ content: 'sm:max-w-2xl' }"
  >
    <template #body>
      <form
        id="session-admission-form"
        class="space-y-5"
        @submit.prevent="submit"
      >
        <CommonEmptyState
          v-if="candidates.length === 0"
          icon="i-lucide-inbox"
          size="sm"
          :title="
            decision === 'admitted'
              ? t('session.admission.emptyAdmit')
              : t('session.admission.emptyInadmit')
          "
        />
        <fieldset v-else class="space-y-2">
          <legend class="text-highlighted mb-2 text-sm font-medium">
            {{ t("session.admission.amendments") }}
          </legend>
          <UCheckbox
            :model-value="allSelected"
            :label="t('session.admission.selectAll')"
            @update:model-value="toggleAll"
          />
          <ul class="border-default divide-default divide-y rounded-lg border">
            <li
              v-for="amendment in candidates"
              :key="amendment.id"
              class="flex flex-wrap items-center gap-2 px-3 py-2"
            >
              <UCheckbox
                :model-value="chosen.includes(amendment.id)"
                :aria-label="
                  t('session.admission.select', {
                    code: session.label(amendment.id),
                  })
                "
                @update:model-value="(value) => toggle(amendment.id, value)"
              />
              <span class="font-semibold tabular-nums">
                {{ session.label(amendment.id) }}
              </span>
              <CommonMemberBadge
                v-for="author in amendment.authors"
                :key="author.id"
                :member="author"
                size="xs"
              />
              <UBadge
                v-if="amendment.late"
                color="warning"
                variant="subtle"
                size="sm"
                :label="t('session.queue.late')"
              />
              <CommonStatusBadge
                v-if="amendment.admission !== 'admitted'"
                kind="admission"
                :value="amendment.admission"
                size="sm"
              />
            </li>
          </ul>
        </fieldset>

        <URadioGroup
          v-model="decision"
          :legend="t('session.admission.decision')"
          :items="decisionItems"
          orientation="horizontal"
        />
        <URadioGroup
          v-model="method"
          :legend="t('session.admission.method')"
          :items="methodItems"
          orientation="horizontal"
          :ui="{ fieldset: 'flex-wrap gap-x-4 gap-y-2' }"
        />

        <SessionVoteFields
          v-if="method === 'vote'"
          v-model="vote"
          :settings="session.settings.value"
          :headcount="session.voteHeadcount.value"
          :show-note="false"
        />

        <UFormField :label="t('session.admission.note')" name="admission-note">
          <UTextarea
            v-model="note"
            :rows="2"
            autoresize
            :maxlength="2000"
            class="w-full"
          />
        </UFormField>
      </form>
    </template>
    <template #footer="{ close }">
      <div class="flex w-full flex-wrap justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :label="t('common.cancel')"
          @click="close"
        />
        <UButton
          type="submit"
          form="session-admission-form"
          :color="decision === 'admitted' ? 'primary' : 'error'"
          :icon="
            decision === 'admitted' ? 'i-lucide-check' : 'i-lucide-octagon-x'
          "
          :label="
            decision === 'admitted'
              ? t(
                  'session.admission.submitAdmit',
                  { count: chosen.length },
                  chosen.length,
                )
              : t(
                  'session.admission.submitReject',
                  { count: chosen.length },
                  chosen.length,
                )
          "
          :loading="Boolean(session.busy.value.admission)"
          :disabled="blocked"
        />
      </div>
    </template>
  </UModal>
</template>
