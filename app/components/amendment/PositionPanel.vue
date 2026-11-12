<script setup lang="ts">
import type { ProponentPosition } from "~~/shared/constants/domain";
import type {
  AmendmentDto,
  DocumentDto,
  PositionBody,
} from "~~/shared/types/api";
import {
  amendmentAwaitsPosition,
  amendmentPositionBlocker,
  amendmentPositionNext,
  type AmendmentPositionContext,
} from "~/composables/amendment/workspace";
import {
  acceptIncorporates,
  answersReserved,
} from "~/components/proponent-review/-review";

/**
 * The answer of the document's main presenter to an amendment (accept,
 * reject, propose a transactional), said as who, what and when, so its
 * co-presenters always see what it decided. An answer the Mesa recorded on
 * the presenter's behalf says so ("La Mesa, en nombre de CEUM, la
 * aceptó"). Then what happens next by the document's rule ("Si la acepta
 * quien presenta el documento, se incorpora sin votación" / "La votará la
 * asamblea").
 *
 * It can be answered (`can.position`: the main presenter, or the Mesa for
 * it) only once the amendment reached it: published by the Secretaría (so
 * validated), admitted if late, and for a transactional, accepted by the
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
 * Answering is the main action for the main presenter while nobody has
 * answered yet ("Responder", solid); changing an answer, or the Mesa
 * recording one for it, is a small secondary action. Saving sends the
 * answer seen when the form opened (`positionUpdatedAt`), so two people
 * answering at once get a conflict instead of overwriting each other; live
 * updates never reset a form being filled in.
 */
const props = defineProps<{
  amendment: AmendmentDto;
  /** URL of the amendment: .../amendments/{id}. */
  url: string;
  document: Pick<DocumentDto, "proponent" | "acceptedAmendments"> &
    Partial<Pick<DocumentDto, "finalVote">>;
  /** Labels of the approved amendments it overlaps with (incorporatedClashIds). */
  clashes?: string[];
  /** Labels of the pending transactionals over it. */
  withdraws?: string[];
}>();

const emit = defineEmits<{
  updated: [amendment: AmendmentDto];
  conflict: [];
}>();

const { t, locale } = useI18n();
const api = useApi();
const toast = useToast();
const { member } = useMe();
const { assembly } = useCurrentAssembly();

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
  const reserved = answersReserved(
    assembly.value?.settings.positionVisibility ?? "session",
    assembly.value?.status,
  );
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
const items = computed(() =>
  OPTIONS.map((value) => ({
    label: t(`amendment.position.options.${value}`),
    description:
      value === "accept" && props.document.acceptedAmendments === "incorporate"
        ? [
            t("amendment.position.descriptions.acceptIncorporate"),
            ...acceptConsequences.value,
          ].join(" ")
        : t(`amendment.position.descriptions.${value}`),
    value,
  })),
);

/** Who answers: the main presenter, by its acronym. */
const presenter = computed(
  () =>
    props.document.proponent?.acronym ?? t("amendment.position.thePresenter"),
);
const isMainPresenter = computed(
  () =>
    props.document.proponent !== null &&
    props.document.proponent.id === member.value?.id,
);
const answer = computed(() => props.amendment.position?.position ?? "pending");
/**
 * Who said it: the main presenter ("Respuesta de CEUM: la acepta"), or the
 * Mesa on its behalf ("La Mesa, en nombre de CEUM, la aceptó").
 */
const answerText = computed(() => {
  const value = answer.value;
  if (value === "pending") return null;
  return props.amendment.position?.recordedBy === "mesa"
    ? t(`amendment.position.answersByMesa.${value}`, {
        member: presenter.value,
      })
    : t(`amendment.position.answers.${value}`, { member: presenter.value });
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
}));
const reachable = computed(() =>
  amendmentAwaitsPosition(
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
/** The main presenter's first answer: the main action of the detail. */
const answerFirst = computed(
  () => canEdit.value && isMainPresenter.value && answer.value === "pending",
);
const editLabel = computed(() => {
  if (!isMainPresenter.value) {
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
  if (blocker.value === "publication") {
    return t("amendment.position.blocked.publication");
  }
  return isMainPresenter.value
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

async function save(): Promise<void> {
  saving.value = true;
  const before = answer.value;
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
    const incorporate = props.document.acceptedAmendments === "incorporate";
    toast.add({
      title: t("amendment.position.saved"),
      description: incorporate
        ? position.value === "accept"
          ? t("amendment.position.savedIncorporated")
          : before === "accept"
            ? t("amendment.position.savedReopened")
            : undefined
        : undefined,
      color: "success",
      icon: "i-lucide-check",
    });
    emit("updated", updated);
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
            next === 'incorporated'
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
