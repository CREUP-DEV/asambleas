<script setup lang="ts">
import type { ProponentPosition } from "~~/shared/constants/domain";
import { amendmentRule } from "~~/shared/utils/positions";
import type {
  AmendmentDto,
  DocumentDto,
  PositionBody,
} from "~~/shared/types/api";
import {
  amendmentAnswerable,
  amendmentAwaitsPosition,
  amendmentPositionBlocker,
  amendmentPositionNext,
  presenterSeesValidated,
  type AmendmentPositionContext,
} from "~/composables/amendment/workspace";
import { proposedByPresenter } from "~/composables/amendment/transactional";
import {
  combinableOnTransact,
  composerTakes,
  pendingTransactionalsOver,
  type TransactAnswerResult,
} from "~/composables/amendment/transactAnswer";
import { useTransactAnswer } from "~/composables/amendment/useTransactAnswer";
import {
  acceptIncorporates,
  answersReserved,
  isIncorporated,
  wasReopened,
} from "~/components/proponent-review/-review";

/**
 * The answer of the document's presenters to an amendment (accept, reject,
 * propose a transactional), given by the main presenter or a co-presenter
 * and said as who (`answeredBy`), what and when, so every presenter sees
 * what the others decided. An answer the Mesa recorded on
 * the presenter's behalf says so ("La Mesa, en nombre de CEUM, la
 * aceptó"). Then what happens next by the document's rule ("Si la acepta
 * quien presenta el documento, se incorpora sin votación" / "La votará la
 * asamblea").
 *
 * It can be answered (`can.position`: any presenter, or the Mesa for them)
 * only once the amendment reached it: published by the Secretaría (so
 * validated; a late one before the assembly admits it), and for a
 * transactional, accepted by the
 * main authors (amendmentAwaitsPosition), and never after the document's
 * final vote. Until then it only says it can be answered later: the review
 * panel above already says what it waits for, except publication, which
 * the Mesa (who sees a private amendment, with its authors and the
 * Secretaría) is told here. Under the "incorporate" rule the answer can
 * change until the final vote: accepting approves it at once, and changing
 * it reopens it. While accepting would incorporate it (acceptIncorporates),
 * the form says quietly what that sets off: the amendments already in the
 * text it clashes with (`clashes`), the pending transactionals it withdraws
 * (`withdraws`, back if the answer changes before the final vote; only the
 * ones the viewer can see, `transactionalIds`, so one still unpublished and
 * waiting for its parties goes unnamed, though it comes back too) and, when
 * the answers are still reserved (answersReserved), that everyone sees the
 * approval anyway.
 *
 * An amendment the assembly already approved (by a vote, by assent or as a
 * formal one) can still be answered until the final vote (user's decision
 * of 2026-11-19, amendmentAnswerable): the answer is recorded and the
 * approval stays, which the panel says instead of what the rule would do;
 * it is never "your turn" there, only the small secondary action.
 *
 * Answering is the main action for a presenter while nobody has
 * answered yet ("Responder", solid); changing an answer, or the Mesa
 * recording one for it, is a small secondary action. Saving sends the
 * answer seen when the form opened (`positionUpdatedAt`), so two people
 * answering at once get a conflict instead of overwriting each other; live
 * updates never reset a form being filled in.
 *
 * Saving «Propone una transaccional» where the viewer may write it here
 * (`transactable`) over an amendment a transactional can combine asks
 * first (useTransactAnswer, user's decision of 2026-11-21): writing it
 * saves the answer and opens the workspace's composer on it (`transact`),
 * or the transactional already on its way (`open`); «Solo guardar la
 * respuesta» only saves it; cancelling saves nothing.
 */
const props = defineProps<{
  amendment: AmendmentDto;
  /** URL of the amendment: .../amendments/{id}. */
  url: string;
  document: Pick<
    DocumentDto,
    | "proponent"
    | "coProponents"
    | "acceptedAmendments"
    | "positionsPublishedAt"
    | "positionsDebateStartedAt"
  > &
    Partial<Pick<DocumentDto, "finalVote">>;
  /** Labels of the approved amendments it overlaps with (incorporatedClashIds). */
  clashes?: string[];
  /** Labels of the pending transactionals over it. */
  withdraws?: string[];
  /**
   * The viewer may write a transactional over it in this workspace
   * (canTransact): answering «Propone una transaccional» then asks whether
   * to write it (useTransactAnswer; user's decision of 2026-11-21).
   */
  transactable?: boolean;
  /** The document's amendments by id: the transactionals on their way. */
  byId?: ReadonlyMap<string, AmendmentDto>;
}>();

const emit = defineEmits<{
  updated: [amendment: AmendmentDto];
  conflict: [];
  /** Open the workspace's transactional composer on these amendments. */
  transact: [ids: string[]];
  /** Open this amendment (the transactional on its way over this one). */
  open: [id: string];
}>();

const { t, locale } = useI18n();
const api = useApi();
const toast = useToast();
const { member } = useMe();

const titleId = useId();
const editing = ref(false);
const saving = ref(false);
const position = ref<ProponentPosition>("pending");
const comment = ref("");
/** The answer's stamp when the form opened: the one this save replaces. */
const seen = ref<string | null>(null);

function reset(): void {
  position.value = props.amendment.position?.position ?? "pending";
  comment.value = props.amendment.position?.comment ?? "";
}

// A refresh (any live event on the document) brings fresh objects: only
// follow them while the form is closed, so what is being typed survives.
watch(
  () => props.amendment.position,
  () => {
    if (!editing.value) reset();
  },
  { immediate: true },
);
watch(
  () => props.amendment.id,
  () => {
    editing.value = false;
    reset();
  },
);

/** Answers first; "no answer yet" last. */
const OPTIONS: ProponentPosition[] = [
  "accept",
  "reject",
  "transact",
  "pending",
];
/** Accepting approves it at once, with what that sets off. */
const incorporates = computed(() =>
  acceptIncorporates(props.amendment, props.document.acceptedAmendments),
);
/** Under "Aceptar" while it would incorporate it: what else that does. */
const acceptConsequences = computed(() => {
  if (!incorporates.value) return [];
  const withdraws = props.withdraws ?? [];
  const reserved = answersReserved(props.document);
  return [
    withdraws.length > 0
      ? t(
          "amendment.position.descriptions.acceptWithdraws",
          { list: withdraws.join(", ") },
          withdraws.length,
        )
      : null,
    reserved ? t("amendment.position.descriptions.acceptRevealed") : null,
  ].filter((line): line is string => line !== null);
});
const clashText = computed(() => {
  const clashes = props.clashes ?? [];
  return incorporates.value && clashes.length > 0
    ? t(
        "amendment.position.clashIncorporated",
        { list: clashes.join(", ") },
        clashes.length,
      )
    : null;
});
/**
 * What each answer does. On an amendment already decided they do nothing
 * else (one line above the options says so), so they carry no description.
 */
const items = computed(() =>
  OPTIONS.map((value) => ({
    label: t(`amendment.position.options.${value}`),
    description: afterDecision.value
      ? undefined
      : value === "accept" &&
          amendmentRule(
            props.amendment.kind,
            props.document.acceptedAmendments,
          ) === "incorporate"
        ? [
            t("amendment.position.descriptions.acceptIncorporate"),
            ...acceptConsequences.value,
          ].join(" ")
        : t(`amendment.position.descriptions.${value}`),
    value,
  })),
);

/** Who answers: the main presenter, by its acronym. */
const presenter = computed(() =>
  props.document.proponent
    ? memberSpokenName(props.document.proponent)
    : t("amendment.position.thePresenter"),
);
/** The viewer acts for a presenter: the main one or a co-presenter. */
const isPresenter = computed(() => {
  const id = member.value?.id;
  if (!id) return false;
  return (
    props.document.proponent?.id === id ||
    props.document.coProponents.some((presenter) => presenter.id === id)
  );
});
/**
 * Who gave a presenter's answer: the co-presenter that answered, named as
 * the document names it, else the main presenter.
 */
const answerer = computed(() => {
  const id = props.amendment.position?.answeredBy;
  const found = id
    ? [props.document.proponent, ...props.document.coProponents].find(
        (presenter) => presenter?.id === id,
      )
    : null;
  return found ? memberSpokenName(found) : presenter.value;
});
const answer = computed(() => props.amendment.position?.position ?? "pending");
/**
 * Who said it: the main presenter ("Respuesta de CEUM: la acepta"), the
 * Mesa on its behalf ("La Mesa, en nombre de CEUM, la aceptó"), or nobody
 * (a formal amendment, accepted by itself).
 */
const answerText = computed(() => {
  const value = answer.value;
  if (value === "pending") return null;
  if (props.amendment.position?.recordedBy === "auto" && value === "accept") {
    return t("amendment.position.answerAuto");
  }
  return props.amendment.position?.recordedBy === "mesa"
    ? t(
        `amendment.position.answersBy${positionRecorderKey(props.amendment.position)}.${value}`,
        { member: presenter.value },
      )
    : t(`amendment.position.answers.${value}`, { member: answerer.value });
});
const answeredAt = computed(() =>
  answer.value !== "pending" && props.amendment.position
    ? formatDateTime(props.amendment.position.updatedAt, {
        locale: locale.value,
      })
    : null,
);

/** Nothing is answered once the document was voted. */
const context = computed<AmendmentPositionContext>(() => ({
  finalVoted: Boolean(props.document.finalVote),
  presenterSeesValidated: presenterSeesValidated(props.document),
}));
/** It can be answered now, also once the assembly approved it. */
const reachable = computed(() =>
  amendmentAnswerable(
    props.amendment,
    props.document.acceptedAmendments,
    context.value,
  ),
);
/**
 * Already approved by the assembly: answerable, but never waiting for the
 * answer (amendmentAwaitsPosition), so never the presenter's turn.
 */
const afterDecision = computed(
  () =>
    reachable.value &&
    !amendmentAwaitsPosition(
      props.amendment,
      props.document.acceptedAmendments,
      context.value,
    ),
);
const blocker = computed(() =>
  amendmentPositionBlocker(
    props.amendment,
    props.document.acceptedAmendments,
    context.value,
  ),
);
const next = computed(() =>
  amendmentPositionNext(
    props.amendment,
    props.document.acceptedAmendments,
    context.value,
  ),
);
/** What happens next, as a key. */
const nextKey = computed(() =>
  next.value ? `amendment.position.next.${next.value}` : null,
);
const canEdit = computed(
  () => props.amendment.can.position && reachable.value && !editing.value,
);
/** A presenter's first answer: the main action of the detail. */
const answerFirst = computed(
  () =>
    canEdit.value &&
    isPresenter.value &&
    answer.value === "pending" &&
    !afterDecision.value,
);
const editLabel = computed(() => {
  if (!isPresenter.value) {
    return t("amendment.position.recordFor", { member: presenter.value });
  }
  return answer.value === "pending"
    ? t("amendment.position.answer")
    : t("amendment.position.edit");
});
/**
 * Not answerable yet: who will answer it, later. Waiting for publication
 * says so: the review panel only says it is not public yet.
 */
const laterText = computed(() => {
  // A presenter presented this transactional: presenting it is its
  // acceptance, recorded once it can be answered (user's decision of
  // 2026-11-21).
  const proposer = props.amendment.proposer?.member;
  if (
    proposer &&
    props.amendment.status === "submitted" &&
    !props.document.finalVote &&
    proposedByPresenter(props.amendment)
  ) {
    return t("amendment.position.acceptsOnProposing", {
      member: memberSpokenName(proposer),
    });
  }
  if (blocker.value === "publication") {
    return t("amendment.position.blocked.publication");
  }
  return isPresenter.value
    ? t("amendment.position.laterYou")
    : t("amendment.position.later", { member: presenter.value });
});

function startEditing(): void {
  reset();
  seen.value = props.amendment.position?.updatedAt ?? null;
  editing.value = true;
}

function cancel(): void {
  editing.value = false;
  reset();
}

const transactQuestion = useTransactAnswer();
/**
 * «Propone una transaccional», newly chosen over an amendment a
 * transactional can combine, for a viewer who may write it here: asked
 * before saving (cancelling saves nothing and puts the saved answer back
 * in the form). Null when nothing is asked.
 */
async function askTransact(): Promise<TransactAnswerResult | null> {
  if (
    position.value !== "transact" ||
    answer.value === "transact" ||
    !props.transactable ||
    !combinableOnTransact(props.amendment)
  ) {
    return null;
  }
  return transactQuestion.ask({
    code: props.amendment.code ?? t("amendment.unnumberedLabel"),
    mesaFor: isPresenter.value ? null : presenter.value,
    pending: pendingTransactionalsOver(
      props.amendment,
      props.byId ?? new Map(),
    ).map((entry) => ({
      id: entry.id,
      label: entry.code ?? t("amendment.unnumberedLabel"),
    })),
  });
}

/** After the answer is saved: the composer, or the transactional on its way. */
function afterTransact(
  updated: AmendmentDto,
  result: TransactAnswerResult | null,
): void {
  if (result?.action === "open") {
    emit("open", result.id);
  } else if (result?.action === "draft") {
    if (composerTakes(updated, props.byId ?? new Map())) {
      emit("transact", [updated.id]);
    } else {
      toast.add({
        title: t("amendment.transactAnswer.notCombinable", {
          code: updated.code ?? t("amendment.unnumberedLabel"),
        }),
        color: "warning",
        icon: "i-lucide-triangle-alert",
      });
    }
  }
}

async function save(): Promise<void> {
  if (saving.value || transactQuestion.asking.value) return;
  const transacting = await askTransact();
  if (transacting?.action === "cancel") {
    position.value = answer.value;
    return;
  }
  saving.value = true;
  const before = {
    status: props.amendment.status,
    approvalMethod: props.amendment.approvalMethod,
  };
  const decided = afterDecision.value;
  try {
    const body: PositionBody = {
      position: position.value,
      comment: comment.value.trim() || null,
      positionUpdatedAt: seen.value,
    };
    const updated = await api.send<AmendmentDto>(`${props.url}/position`, {
      method: "PUT",
      body,
    });
    editing.value = false;
    // What the server did with it, read from the amendment it returns.
    toast.add({
      title: t("amendment.position.saved"),
      description:
        position.value === "accept" && isIncorporated(updated)
          ? t("amendment.position.savedIncorporated")
          : wasReopened(before, updated)
            ? t("amendment.position.savedReopened")
            : decided
              ? t("amendment.position.savedDecided")
              : undefined,
      color: "success",
      icon: "i-lucide-check",
    });
    emit("updated", updated);
    afterTransact(updated, transacting);
  } catch (error) {
    api.notifyError(error, "amendment.position.saveFailed");
    if (api.isConflict(error)) {
      // Answered meanwhile (or no longer answerable): show what stands now,
      // which the refresh brings; retrying would only conflict again.
      editing.value = false;
      reset();
      emit("conflict");
    }
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="flex flex-col gap-3" :aria-labelledby="titleId">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h3 :id="titleId" class="text-highlighted text-sm font-semibold">
        {{ t("amendment.position.title") }}
      </h3>
      <UButton
        v-if="canEdit && !answerFirst"
        icon="i-lucide-reply"
        color="neutral"
        variant="outline"
        size="xs"
        :label="editLabel"
        @click="startEditing"
      />
    </div>

    <template v-if="!editing">
      <!-- Who answered, what and when. -->
      <div v-if="answer !== 'pending'" class="flex flex-col gap-1.5">
        <p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <CommonStatusBadge kind="position" :value="answer" size="xs" />
          <span class="text-default">{{ answerText }}</span>
          <span v-if="answeredAt" class="text-dimmed text-xs">
            {{ answeredAt }}
          </span>
        </p>
        <p
          v-if="amendment.position?.comment"
          class="text-default border-default border-s-2 ps-3 text-sm whitespace-pre-line"
        >
          {{ amendment.position.comment }}
        </p>
      </div>
      <!-- Not answerable yet: the review panel says what it waits for. -->
      <p v-else-if="blocker" class="text-muted text-sm">
        {{ laterText }}
      </p>
      <p v-else-if="answerFirst" class="text-highlighted text-sm font-medium">
        {{ t("amendment.position.yourTurn") }}
      </p>
      <p v-else-if="reachable" class="text-muted text-sm">
        {{ t("amendment.position.answers.pending", { member: presenter }) }}
      </p>
      <p v-else class="text-muted text-sm">
        {{ t("amendment.position.answers.none", { member: presenter }) }}
      </p>

      <!-- What happens next, by the document's rule. -->
      <p v-if="nextKey" class="text-default flex items-start gap-1.5 text-sm">
        <UIcon
          :name="
            next === 'incorporated' || next === 'decided'
              ? 'i-lucide-circle-check'
              : 'i-lucide-arrow-right'
          "
          class="text-muted mt-0.5 size-4 shrink-0"
          aria-hidden="true"
        />
        {{ t(nextKey) }}
      </p>

      <UButton
        v-if="answerFirst"
        class="self-start"
        icon="i-lucide-reply"
        size="sm"
        :label="editLabel"
        @click="startEditing"
      />
    </template>

    <form v-else class="flex flex-col gap-3" @submit.prevent="save">
      <p v-if="clashText" class="text-muted flex items-start gap-1.5 text-sm">
        <UIcon
          name="i-lucide-layers"
          class="mt-0.5 size-4 shrink-0"
          aria-hidden="true"
        />
        <span>{{ clashText }}</span>
      </p>
      <p
        v-if="afterDecision"
        class="text-muted flex items-start gap-1.5 text-sm"
      >
        <UIcon
          name="i-lucide-circle-check"
          class="mt-0.5 size-4 shrink-0"
          aria-hidden="true"
        />
        <span>{{ t("amendment.position.next.decided") }}</span>
      </p>
      <URadioGroup
        v-model="position"
        :items="items"
        :legend="t('amendment.position.label')"
        variant="card"
        size="sm"
      />
      <UFormField :label="t('amendment.position.comment')">
        <UTextarea
          v-model="comment"
          :rows="3"
          autoresize
          class="w-full"
          :maxlength="2000"
          :placeholder="t('amendment.position.commentPlaceholder')"
        />
      </UFormField>
      <div class="flex flex-wrap justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :label="t('amendment.actions.cancel')"
          :disabled="saving"
          @click="cancel"
        />
        <UButton
          type="submit"
          icon="i-lucide-check"
          :loading="saving"
          :label="t('amendment.position.save')"
        />
      </div>
    </form>
  </section>
</template>
