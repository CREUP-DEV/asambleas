<script setup lang="ts">
import type { AdmissionBody, VoteInput } from "~~/shared/types/api";
import type { AssemblySettings } from "~~/shared/constants/domain";
import type { AdmissionChoice } from "./-queue";
import {
  isSessionVoteReady,
  sessionCleanVote,
  sessionVoteCast,
  sessionEmptyVote,
  sessionVoteOutcome,
} from "~/composables/session/sessionModel";

/**
 * "Anotar la decisión de la asamblea" on one or more late amendments: how it
 * was decided (the Mesa, assent or a vote with its counts) and what (treat
 * them or not). A vote is always on treating them, so its counts decide the
 * result; a failed vote leaves them out. The method starts unselected, so
 * nobody records "Lo decide la Mesa" without choosing it, and the summary
 * names who decided: the Mesa, or the assembly by assent or vote. When every
 * amendment is already public (`allPublic`) it does not say they will be.
 * The parent sends the body (POST .../amendments/admission) on `confirm` and
 * closes the dialog when it succeeds.
 */
type AdmissionDecision = AdmissionBody["decision"];
type AdmissionMethod = "mesa" | "assent" | "vote";

const props = withDefaults(
  defineProps<{
    /** What is decided on: "CEUM 4", or "3 enmiendas". */
    subject: string;
    /** How many amendments, for plurals. */
    count: number;
    /** Title of their document, shown when there are several. */
    documentTitle: string;
    /** The decision the dialog opens with (the button that opened it). */
    initialDecision?: AdmissionDecision;
    settings: Pick<AssemblySettings, "denominator" | "tieRule">;
    busy?: boolean;
    /** Every amendment is already published: treating them only opens debate. */
    allPublic?: boolean;
  }>(),
  { initialDecision: "admitted", busy: false, allPublic: false },
);

const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{ confirm: [choice: AdmissionChoice] }>();

const { t } = useI18n();
const formId = useId();

const method = ref<AdmissionMethod | undefined>(undefined);
const decision = ref<AdmissionDecision>(props.initialDecision);
const vote = ref<VoteInput>(sessionEmptyVote("simple"));
const note = ref("");

watch(open, (isOpen) => {
  if (!isOpen) return;
  method.value = undefined;
  decision.value = props.initialDecision;
  vote.value = sessionEmptyVote("simple");
  note.value = "";
});

const methodItems = computed(() =>
  (["mesa", "assent", "vote"] as const).map((value) => ({
    value,
    label: t(`review.late.dialog.methods.${value}`),
    description: t(`review.late.dialog.methods.${value}Help`),
  })),
);

const decisionItems = computed(() => [
  {
    value: "admitted",
    label: t("review.late.dialog.treat", props.count),
  },
  {
    value: "inadmissible",
    label: t("review.late.dialog.notTreat", props.count),
  },
]);

const outcome = computed(() => sessionVoteOutcome(vote.value, props.settings));
const voteReady = computed(() => isSessionVoteReady(vote.value, outcome.value));

/** What will be recorded, or null while the counts do not settle it. */
const effective = computed<AdmissionDecision | null>(() => {
  if (!method.value) return null;
  if (method.value !== "vote") return decision.value;
  if (!voteReady.value) return null;
  return outcome.value.result === "approved" ? "admitted" : "inadmissible";
});

const summary = computed(() => {
  if (!method.value) return t("review.late.dialog.summaryNoMethod");
  const byMesa = method.value === "mesa";
  if (effective.value === "admitted") {
    const key = byMesa
      ? props.allPublic
        ? "review.late.dialog.summaryTreatMesaPublic"
        : "review.late.dialog.summaryTreatMesa"
      : props.allPublic
        ? "review.late.dialog.summaryTreatPublic"
        : "review.late.dialog.summaryTreat";
    return t(key, { subject: props.subject }, props.count);
  }
  if (effective.value === "inadmissible") {
    return t(
      byMesa
        ? "review.late.dialog.summaryNotTreatMesa"
        : "review.late.dialog.summaryNotTreat",
      { subject: props.subject },
      props.count,
    );
  }
  // Nothing to record yet: say what to fix, most blocking first.
  if (sessionVoteCast(vote.value) === 0) {
    return t("review.late.dialog.summaryNoVotes");
  }
  if (outcome.value.inconsistent) {
    return t("review.late.dialog.summaryInconsistent");
  }
  return outcome.value.result === "tie"
    ? t("review.late.dialog.summaryTie")
    : t("review.late.dialog.summaryNoVotes");
});

const description = computed(() =>
  props.count === 1
    ? t("review.late.dialog.descriptionOne", { subject: props.subject })
    : t("review.late.dialog.descriptionMany", {
        count: props.count,
        title: props.documentTitle,
      }),
);

function submit() {
  if (props.busy || !method.value || effective.value === null) return;
  const trimmed = note.value.trim() || null;
  if (method.value === "vote") {
    // The vote is on treating them: the server applies its result.
    emit("confirm", {
      decision: "admitted",
      method: "vote",
      note: trimmed,
      vote: sessionCleanVote({ ...vote.value, majority: "simple" }),
    });
    return;
  }
  emit("confirm", {
    decision: decision.value,
    method: method.value,
    note: trimmed,
    vote: null,
  });
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('review.late.dialog.title')"
    :description="description"
    :dismissible="!props.busy"
    :ui="{ content: 'sm:max-w-xl' }"
  >
    <template #body>
      <form :id="formId" class="space-y-5" @submit.prevent="submit">
        <URadioGroup
          v-model="method"
          :legend="t('review.late.dialog.method')"
          :items="methodItems"
          :disabled="props.busy"
        />

        <URadioGroup
          v-if="method !== 'vote'"
          v-model="decision"
          :legend="t('review.late.dialog.decision')"
          :items="decisionItems"
          orientation="horizontal"
          :disabled="props.busy"
          :ui="{ fieldset: 'flex-wrap gap-x-6 gap-y-2' }"
        />

        <div v-else class="space-y-3">
          <p class="text-muted text-sm">
            {{ t("review.late.dialog.voteHelp", props.count) }}
          </p>
          <SessionVoteFields
            v-model="vote"
            :settings="props.settings"
            :show-majority="false"
            :show-note="false"
          />
        </div>

        <UFormField
          :label="t('review.late.dialog.note')"
          :hint="t('review.late.dialog.optional')"
          :help="t('review.late.dialog.noteHelp')"
          name="admission-note"
        >
          <UTextarea
            v-model="note"
            :rows="2"
            autoresize
            :maxrows="6"
            :maxlength="2000"
            :disabled="props.busy"
            class="w-full"
          />
        </UFormField>

        <p
          class="flex items-start gap-2 rounded-md p-3 text-sm"
          :class="
            effective === null
              ? 'bg-elevated/50 text-muted'
              : 'bg-primary/5 text-highlighted'
          "
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <UIcon
            :name="
              effective === 'admitted'
                ? 'i-lucide-check'
                : effective === 'inadmissible'
                  ? 'i-lucide-x'
                  : 'i-lucide-info'
            "
            class="mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          <span>{{ summary }}</span>
        </p>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full flex-wrap justify-end gap-2">
        <UButton
          color="neutral"
          variant="outline"
          :label="t('common.cancel')"
          :disabled="props.busy"
          @click="open = false"
        />
        <UButton
          type="submit"
          :form="formId"
          icon="i-lucide-save"
          :label="t('review.late.dialog.save')"
          :loading="props.busy"
          :disabled="effective === null"
        />
      </div>
    </template>
  </UModal>
</template>
