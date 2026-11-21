<script setup lang="ts">
import type { AmendmentDto, VoteInput } from "~~/shared/types/api";
import {
  DECISION_METHODS,
  type DecisionMethod,
} from "~~/shared/constants/domain";
import {
  sessionAdmissionTransactionalEffects,
  isSessionVoteReady,
  sessionAdmissionCandidates,
  sessionCleanVote,
  sessionEmptyVote,
  sessionVoteOutcome,
  type SessionAdmissionDecision,
} from "~/composables/session/sessionModel";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";
import type { LiveTallyAnnounce } from "~/composables/session/liveTally";
import {
  admissionPurposeOf,
  isSessionProposalMismatch,
  isSessionProposalOnScreen,
  sessionAdmissionProposalPlan,
} from "~/composables/session/admissionProposal";

/**
 * A secret vote counted here announces a decision of the Mesa: the
 * decision has no row before it is recorded, and the amendments it
 * decides may not be public yet, so none is named.
 */
const ADMISSION_ANNOUNCE: LiveTallyAnnounce = {
  subject: { type: "decision", id: null },
};

/**
 * Admits amendments or declares them inadmissible, one by one or in bulk:
 * late amendments pending admission, an on-time amendment the Mesa finds
 * inadmissible, or an inadmissible one to re-admit after a mistake. The
 * decision is recorded with its method (Mesa, Secretaría, assent or a vote
 * with its counts) and an optional note. The console in control may first
 * put the late ones ticked on screen as a proposal (user's decision of
 * 2026-11-21): only published ones, the others counted.
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
  // "Present" opens empty: the latest headcount fills it (VoteDialog).
  vote.value = sessionEmptyVote("simple");
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

// An empty "present" counts on the latest headcount, as on the server.
const outcome = computed(() =>
  sessionVoteOutcome(
    vote.value,
    session.settings.value,
    session.voteHeadcount.value,
  ),
);

/**
 * What the decision does to the transactionals over it, said on its row
 * (sessionAdmissionTransactionalEffects): admitted, it goes into them; not
 * admitted, it leaves them, and one left with no parent lapses.
 */
function transactionalsLine(amendment: AmendmentDto): string | null {
  const effects = sessionAdmissionTransactionalEffects(
    amendment.id,
    decision.value,
    chosen.value,
    session.byId.value,
  );
  if (effects.length === 0) return null;
  return effects
    .map((entry) =>
      t(`session.admission.transactionalEffect.${entry.effect}`, {
        code: session.label(entry.transactionalId),
      }),
    )
    .join(" ");
}
/**
 * Where the note goes, worded as in Validación's AdmissionModal: not
 * admitting them makes it the reason their authors read by email and
 * everyone reads with the amendment (its outcome note), and so does a vote
 * that does not pass; admitting them leaves it in the decision's record.
 */
const noteField = computed(() => {
  const count = Math.max(chosen.value.length, 1);
  if (method.value === "vote") {
    return {
      label: t("session.admission.note"),
      help: t("review.late.dialog.voteNoteHelp", count),
    };
  }
  return decision.value === "inadmissible"
    ? {
        label: t("review.late.dialog.reasonLabel", count),
        help: t("review.late.dialog.reasonHelp", count),
      }
    : { label: t("session.admission.note"), help: undefined };
});

const blocked = computed(
  () =>
    chosen.value.length === 0 ||
    proposalMismatch.value ||
    (method.value === "vote" && !isSessionVoteReady(vote.value, outcome.value)),
);

// The proposal on screen (user's decision of 2026-11-21) ----------------------

/**
 * What «Proyectar propuesta» puts on screen: the late amendments ticked
 * that the room can read (published, pending admission), proposed as the
 * decision chosen. `unpublished` counts the document's late ones pending
 * that the Secretaría has not published yet: they cannot go on screen.
 */
const proposalPlan = computed(() =>
  sessionAdmissionProposalPlan(session.amendments.value, chosen.value),
);
const proposalPurpose = computed(() => admissionPurposeOf(decision.value));
/** The room already reads exactly this proposal: the button takes it off. */
const proposalProjected = computed(() =>
  isSessionProposalOnScreen(
    session.roomProposal.value,
    proposalPlan.value.ids,
    proposalPurpose.value,
  ),
);
/**
 * The ticks touch the proposal on screen but are not exactly it, or the
 * decision is the opposite of the one proposed: nothing is recorded until
 * they match or are projected (isSessionProposalMismatch).
 */
const proposalMismatch = computed(() =>
  isSessionProposalMismatch(
    chosen.value,
    decision.value,
    session.roomProposal.value,
    session.byId.value,
  ),
);
/** The mismatch is the direction: the room reads the opposite decision. */
const proposalOpposite = computed(
  () =>
    proposalMismatch.value &&
    session.roomProposal.value !== null &&
    session.roomProposal.value.purpose !== proposalPurpose.value,
);
const liveBusy = computed(() => Boolean(session.busy.value.live));

async function toggleProposal(): Promise<void> {
  if (proposalProjected.value) {
    await session.unprojectBloc();
    return;
  }
  const ids = proposalPlan.value.ids;
  // What goes on screen is what gets decided: the ticks follow it.
  if (await session.projectBloc(ids, proposalPurpose.value)) {
    selected.value = [...ids];
  }
}

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
              <p
                v-if="transactionalsLine(amendment)"
                class="text-default flex w-full items-start gap-1.5 text-xs"
              >
                <UIcon
                  name="i-lucide-git-merge"
                  class="text-warning mt-px size-3.5 shrink-0"
                  aria-hidden="true"
                />
                {{ transactionalsLine(amendment) }}
              </p>
            </li>
          </ul>
          <!-- Only published ones go on screen: the room reads nothing
               else (user's decision of 2026-11-21). -->
          <p
            v-if="session.inControl.value && proposalPlan.unpublished > 0"
            class="text-muted flex items-start gap-1.5 text-xs"
          >
            <UIcon
              name="i-lucide-eye-off"
              class="mt-px size-3.5 shrink-0"
              aria-hidden="true"
            />
            {{
              t(
                "session.admissionProposal.unpublished",
                { count: proposalPlan.unpublished },
                proposalPlan.unpublished,
              )
            }}
          </p>
          <!-- The room decides what it reads: no other selection while a
               proposal is on screen. -->
          <p
            v-if="proposalMismatch"
            class="text-default flex items-start gap-1.5 text-xs"
            role="status"
          >
            <UIcon
              name="i-lucide-monitor"
              class="text-warning mt-px size-3.5 shrink-0"
              aria-hidden="true"
            />
            {{
              proposalOpposite
                ? t("session.admissionProposal.mismatchDecision")
                : t("session.admissionProposal.mismatch")
            }}
          </p>
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
          :announce="ADMISSION_ANNOUNCE"
        />

        <UFormField
          :label="noteField.label"
          :help="noteField.help"
          name="admission-note"
        >
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
        <!-- The proposal on screen, as the bloc to approve is: the room
             reads the codes while the Mesa takes the assent or the vote. -->
        <UButton
          v-if="session.inControl.value && candidates.length > 0"
          class="me-auto"
          color="neutral"
          variant="outline"
          :icon="
            proposalProjected ? 'i-lucide-monitor-off' : 'i-lucide-monitor-up'
          "
          :label="
            proposalProjected
              ? t('session.bloc.unproject')
              : t('session.admissionProposal.project')
          "
          :loading="liveBusy"
          :disabled="
            !proposalProjected &&
            (proposalPlan.ids.length === 0 || !session.inSession.value)
          "
          @click="toggleProposal"
        />
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
