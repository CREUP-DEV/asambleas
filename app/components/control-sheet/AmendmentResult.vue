<script setup lang="ts">
import { amendmentVoteMajority } from "~~/shared/constants/domain";
import type {
  AmendmentDto,
  AmendmentOutcomeDto,
  DocumentSummaryDto,
  OutcomeAction,
  OutcomeBody,
  VoteInput,
} from "~~/shared/types/api";
import {
  isSessionDecidable,
  isSessionPendingAdmission,
  isSessionReopenable,
  sessionCleanVote,
  sessionErrorData,
  sessionMissingAcceptances,
} from "~/composables/session/sessionModel";
import type { ItemVoteContext } from "./-model";

/**
 * Recording an amendment's result from the control sheet (user's decision
 * of 2026-11-19), so it can be noted while the Mesa has already moved the
 * projection on: approved by assent, a vote, withdrawn, lapsed, or a
 * decision taken back. The same endpoint and rules as the console
 * (POST .../outcome), with `project: false`: nothing goes on screen and the
 * projection stays where the Mesa has it. For the Mesa and whoever holds
 * assembly:vote_result, while the session is open (taking a decision back
 * only needs the assembly not closed), never once the document has its
 * final vote.
 */
const props = defineProps<{
  amendment: AmendmentDto;
  /** The document's amendments as loaded, for what a reopening needs. */
  amendments: readonly AmendmentDto[];
  document: DocumentSummaryDto | null;
  /** The document has its final vote: nothing changes any more. */
  finalVoted: boolean;
  apiBase: string;
  context: ItemVoteContext;
  code: string;
}>();
/**
 * Recorded: the amendment as it stands now, for the page to show at once
 * (the buttons follow it); null when a write failed. Either way the page
 * fetches again (a vote or a reopening may change other amendments too).
 */
const emit = defineEmits<{ changed: [outcome: AmendmentOutcomeDto | null] }>();

const { t } = useI18n();
const api = useApi();
const toast = useToast();

const inSession = computed(() => props.context.status === "in_session");
const finalVoted = computed(() => props.finalVoted);

const decidable = computed(
  () =>
    inSession.value && !finalVoted.value && isSessionDecidable(props.amendment),
);
const reopenable = computed(() => {
  if (finalVoted.value || props.context.status === "closed") return false;
  const byId = new Map(props.amendments.map((item) => [item.id, item]));
  return isSessionReopenable(props.amendment, byId);
});

/** Why nothing can be recorded, in one quiet line; null when it can. */
const blocker = computed<string | null>(() => {
  if (decidable.value || reopenable.value) return null;
  if (finalVoted.value) return t("controlSheet.results.finalVoted");
  const amendment = props.amendment;
  if (amendment.status !== "submitted") return null;
  if (!inSession.value) return t("controlSheet.results.notInSession");
  if (isSessionPendingAdmission(amendment)) {
    return t("controlSheet.results.pendingAdmission");
  }
  if (sessionMissingAcceptances(amendment) > 0) {
    return t("controlSheet.results.awaitingAuthors");
  }
  if (!amendment.publishedAt) return t("controlSheet.results.notPublished");
  return null;
});

const busy = ref<string | null>(null);

async function run(action: OutcomeAction): Promise<boolean> {
  if (busy.value) return false;
  busy.value = action.action;
  const body: OutcomeBody = {
    ...action,
    updatedAt: props.amendment.updatedAt,
    ...(action.action === "vote" ? { project: false } : {}),
  };
  try {
    const result = await api.send<AmendmentOutcomeDto>(
      `${props.apiBase}/documents/${encodeURIComponent(props.amendment.documentId)}/amendments/${encodeURIComponent(props.amendment.id)}/outcome`,
      { body },
    );
    toast.add({
      title: t(`controlSheet.results.done.${action.action}`, {
        code: props.code,
      }),
      description:
        action.action === "vote"
          ? result.amendment.status === "approved"
            ? t("controlSheet.results.voteApproved")
            : t("controlSheet.results.voteRejected")
          : undefined,
      color: "success",
      icon: "i-lucide-check",
    });
    emit("changed", result);
    return true;
  } catch (error) {
    if (sessionErrorData(error)?.tie === true) {
      toast.add({
        title: t("session.vote.tieTitle"),
        description: t("session.vote.tieRepeat"),
        color: "warning",
        icon: "i-lucide-scale",
      });
    } else {
      api.notifyError(error, "controlSheet.results.failed");
      emit("changed", null);
    }
    return false;
  } finally {
    busy.value = null;
  }
}

// Asked first: each of these settles the amendment for the record.
type Confirmable = "assent" | "withdraw" | "lapse" | "reopen";
const confirming = ref<Confirmable | null>(null);
const confirmOpen = computed({
  get: () => confirming.value !== null,
  set: (value) => {
    if (!value) confirming.value = null;
  },
});
async function confirm(): Promise<void> {
  const what = confirming.value;
  if (!what) return;
  const action: OutcomeAction =
    what === "assent"
      ? { action: "approve", method: "assent" }
      : what === "reopen" && alternativesSiblings.value.length > 0
        ? { action: "reopen", wholeVote: true }
        : { action: what };
  if (await run(action)) confirming.value = null;
}

/**
 * Decided in a vote between alternatives: reopening it voids that vote and
 * reopens these too (user's decision of 2026-11-20), which the dialog says.
 */
const alternativesSiblings = computed(() => {
  const vote = props.amendment.outcomeVote;
  if (!vote?.options) return [];
  const codeOf = (id: string) =>
    props.amendments.find((item) => item.id === id)?.code ?? "?";
  return vote.options
    .flatMap((option) => option.amendmentIds)
    .filter((id) => id !== props.amendment.id)
    .map(codeOf);
});

const voteOpen = ref(false);
const majority = computed(() =>
  props.document ? amendmentVoteMajority(props.document.kind) : "simple",
);
async function submitVote(vote: VoteInput): Promise<void> {
  if (await run({ action: "vote", vote: sessionCleanVote(vote) })) {
    voteOpen.value = false;
  }
}
</script>

<template>
  <section class="space-y-2" aria-labelledby="control-sheet-result">
    <h3 id="control-sheet-result" class="text-highlighted text-sm font-medium">
      {{ t("controlSheet.results.title") }}
    </h3>
    <ControlSheetVoteLine
      v-if="amendment.outcomeVote"
      :vote="amendment.outcomeVote"
    />
    <div v-if="decidable" class="flex flex-wrap gap-2">
      <UButton
        size="sm"
        icon="i-lucide-check-check"
        :label="t('controlSheet.results.assent')"
        :disabled="busy !== null"
        @click="confirming = 'assent'"
      />
      <UButton
        size="sm"
        color="neutral"
        variant="outline"
        icon="i-lucide-gavel"
        :label="t('controlSheet.results.vote')"
        :disabled="busy !== null"
        @click="voteOpen = true"
      />
      <UButton
        size="sm"
        color="neutral"
        variant="ghost"
        icon="i-lucide-undo-2"
        :label="t('controlSheet.results.withdraw')"
        :disabled="busy !== null"
        @click="confirming = 'withdraw'"
      />
      <UButton
        size="sm"
        color="neutral"
        variant="ghost"
        icon="i-lucide-circle-slash"
        :label="t('controlSheet.results.lapse')"
        :disabled="busy !== null"
        @click="confirming = 'lapse'"
      />
    </div>
    <UButton
      v-else-if="reopenable"
      size="sm"
      color="neutral"
      variant="outline"
      icon="i-lucide-rotate-ccw"
      :label="t('controlSheet.results.reopen')"
      :disabled="busy !== null"
      @click="confirming = 'reopen'"
    />
    <p v-if="blocker" class="text-muted text-sm">{{ blocker }}</p>
    <p v-if="decidable" class="text-muted text-xs">
      {{ t("controlSheet.results.notProjected") }}
    </p>

    <ControlSheetVoteDialog
      v-model:open="voteOpen"
      :title="t('controlSheet.results.voteTitle', { code })"
      :majority="majority"
      :context="context"
      :busy="busy === 'vote'"
      @submit="submitVote"
    />

    <UModal
      v-model:open="confirmOpen"
      :title="
        confirming
          ? t(`controlSheet.results.confirm.${confirming}`, { code })
          : ''
      "
      :description="
        confirming === 'reopen' && alternativesSiblings.length > 0
          ? t('session.alternatives.reopenDescription', {
              codes: alternativesSiblings.join(', '),
            })
          : t('controlSheet.results.notProjected')
      "
    >
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            color="neutral"
            variant="outline"
            :label="t('common.cancel')"
            @click="confirming = null"
          />
          <UButton
            icon="i-lucide-check"
            :label="t('common.confirm')"
            :loading="busy !== null"
            @click="confirm"
          />
        </div>
      </template>
    </UModal>
  </section>
</template>
