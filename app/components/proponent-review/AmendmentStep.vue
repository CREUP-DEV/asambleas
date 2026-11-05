<script setup lang="ts">
import type { RouteLocationRaw } from "vue-router";
import type { AmendmentDto, MemberRef } from "~~/shared/types/api";
import type { Block } from "~~/shared/types/content";
import { NOTE_MAX_LENGTH } from "~~/shared/utils/schemas/amendment";
import {
  PROPONENT_ANSWERS,
  positionAnswer,
  type ProponentAnswer,
} from "./-review";

/**
 * One amendment of the presenter's review: its code, who presents it, where
 * it stands as a sentence, the change in large type, its justification, and
 * the answer: an optional comment and three choices (Aceptar, Rechazar,
 * Transaccionar). Pressing a choice saves it with the comment; the page
 * then moves on. The saved choice shows as pressed and can be changed until
 * the amendment is decided. Once answered, a changed comment gets its own
 * "Guardar comentario", which keeps the answer and stays on the amendment.
 * After "Transaccionar", "Proponer la transaccional" opens the composer of
 * the workspace on this amendment (when it can be combined).
 */
const props = withDefaults(
  defineProps<{
    amendment: AmendmentDto;
    base: Block[];
    /** The choice being saved, if any. */
    busy?: ProponentAnswer | null;
    disabled?: boolean;
    /** The Mesa answers for this member (the document's presenter). */
    onBehalfOf?: MemberRef | null;
    /** Who will read the answer and the comment. */
    visibilityNote?: string | null;
    /** Answered, and the comment typed differs from the saved one. */
    commentChanged?: boolean;
    /** The comment alone is being saved. */
    commentBusy?: boolean;
    /**
     * Where to write the transactional, shown once the answer is
     * "Transaccionar"; null when the amendment cannot be combined or the
     * actor cannot propose one.
     */
    transactTo?: RouteLocationRaw | null;
  }>(),
  {
    busy: null,
    disabled: false,
    onBehalfOf: null,
    visibilityNote: null,
    commentChanged: false,
    commentBusy: false,
    transactTo: null,
  },
);

const comment = defineModel<string>("comment", { default: "" });
const emit = defineEmits<{
  answer: [answer: ProponentAnswer];
  saveComment: [];
}>();

const { t } = useI18n();
const titleId = useId();
const answerId = useId();
const heading = useTemplateRef<HTMLElement>("heading");

const label = computed(
  () => amendmentDisplayLabel(props.amendment) ?? t("proponentReview.noCode"),
);
const answer = computed(() => positionAnswer(props.amendment));

/** Where it stands, and what happens next. */
const stateSentence = computed(() => {
  if (!answer.value) {
    return props.onBehalfOf
      ? t("proponentReview.state.pendingFor", {
          member: props.onBehalfOf.acronym,
        })
      : t("proponentReview.state.pending");
  }
  return t(`proponentReview.state.${answer.value}`);
});

/** When the comment is saved, then who reads it. */
const commentHelp = computed(() =>
  [
    answer.value
      ? t("proponentReview.answer.commentHelpAnswered")
      : t("proponentReview.answer.commentHelpPending"),
    props.visibilityNote,
  ]
    .filter(Boolean)
    .join(" "),
);

/** Late, and the assembly has not decided to treat it yet. */
const awaitingAssembly = computed(
  () => props.amendment.late && props.amendment.admission === "pending",
);

const CHOICES: Record<
  ProponentAnswer,
  { icon: string; color: "success" | "error" | "info"; key: string }
> = {
  accept: { icon: "i-lucide-check", color: "success", key: "a" },
  reject: { icon: "i-lucide-x", color: "error", key: "r" },
  transact: { icon: "i-lucide-handshake", color: "info", key: "t" },
};

const ICON_COLORS: Record<ProponentAnswer, string> = {
  accept: "text-success",
  reject: "text-error",
  transact: "text-info",
};

defineExpose({
  /** Moves focus to the code, so screen readers start from it. */
  focus: () => heading.value?.focus(),
});
</script>

<template>
  <article class="space-y-6" :aria-labelledby="titleId">
    <header class="space-y-2">
      <div class="flex flex-wrap items-center gap-2">
        <h3
          :id="titleId"
          ref="heading"
          tabindex="-1"
          class="text-highlighted text-2xl font-bold tabular-nums outline-none"
        >
          {{ label }}
        </h3>
        <UBadge
          v-if="amendment.kind !== 'partial'"
          color="neutral"
          variant="outline"
          :label="t(`amendment.kinds.${amendment.kind}`)"
        />
        <UBadge
          v-if="amendment.late"
          color="warning"
          variant="subtle"
          icon="i-lucide-clock-alert"
          :label="t('amendment.late')"
        />
      </div>

      <div class="flex flex-wrap items-center gap-1.5 text-sm">
        <span class="text-muted">{{ t("amendment.detail.authors") }}</span>
        <CommonMemberBadge
          v-for="author in amendment.authors"
          :key="author.id"
          :member="author"
          :show-name="amendment.authors.length === 1"
        />
      </div>

      <p
        class="flex items-start gap-1.5 text-sm"
        :class="answer ? 'text-default' : 'text-muted'"
      >
        <UIcon
          :name="answer ? CHOICES[answer].icon : 'i-lucide-circle-dashed'"
          class="mt-0.5 size-4 shrink-0"
          :class="answer ? ICON_COLORS[answer] : ''"
          aria-hidden="true"
        />
        <span>{{ stateSentence }}</span>
      </p>
      <UButton
        v-if="answer === 'transact' && transactTo"
        :to="transactTo"
        color="primary"
        variant="link"
        size="sm"
        class="px-0"
        icon="i-lucide-handshake"
        trailing-icon="i-lucide-arrow-right"
        :label="t('proponentReview.answer.proposeTransactional')"
      />
      <p
        v-if="awaitingAssembly"
        class="text-warning flex items-start gap-1.5 text-sm font-medium"
      >
        <UIcon
          name="i-lucide-clock-alert"
          class="mt-0.5 size-4 shrink-0"
          aria-hidden="true"
        />
        <span>{{ t("proponentReview.state.late") }}</span>
      </p>
    </header>

    <ProponentReviewChange :amendment="amendment" :base="base" />

    <section class="space-y-1">
      <h4 class="text-highlighted text-sm font-semibold">
        {{ t("amendment.detail.justification") }}
      </h4>
      <p
        v-if="amendment.justification"
        class="content-font text-default whitespace-pre-line"
      >
        {{ amendment.justification }}
      </p>
      <p v-else class="text-muted text-sm">
        {{ t("amendment.detail.noJustification") }}
      </p>
    </section>

    <section
      class="border-default bg-elevated/40 space-y-4 rounded-lg border p-4"
      :aria-labelledby="answerId"
    >
      <h4 :id="answerId" class="text-highlighted font-semibold">
        {{ t("proponentReview.answer.title") }}
      </h4>
      <p v-if="onBehalfOf" class="text-muted text-sm">
        {{ t("proponentReview.onBehalf", { member: onBehalfOf.name }) }}
      </p>

      <UFormField
        :label="t('proponentReview.answer.comment')"
        :help="commentHelp"
      >
        <UTextarea
          v-model="comment"
          :rows="2"
          autoresize
          :maxrows="8"
          :maxlength="NOTE_MAX_LENGTH"
          class="w-full"
          :disabled="disabled"
          :placeholder="t('proponentReview.answer.commentPlaceholder')"
        />
      </UFormField>
      <div v-if="commentChanged" class="flex justify-end">
        <UButton
          color="neutral"
          variant="outline"
          size="sm"
          icon="i-lucide-message-square-text"
          :loading="commentBusy"
          :disabled="disabled || (busy !== null && !commentBusy)"
          :label="t('proponentReview.answer.saveComment')"
          @click="!commentBusy && emit('saveComment')"
        />
      </div>

      <div
        class="grid gap-2 sm:grid-cols-3"
        role="group"
        :aria-label="t('proponentReview.answer.title')"
      >
        <UButton
          v-for="choice in PROPONENT_ANSWERS"
          :key="choice"
          :color="answer === choice ? CHOICES[choice].color : 'neutral'"
          :variant="answer === choice ? 'solid' : 'outline'"
          size="lg"
          block
          class="h-auto flex-col items-start gap-1 px-4 py-3 text-start"
          :aria-pressed="answer === choice"
          :aria-keyshortcuts="CHOICES[choice].key"
          :aria-busy="busy === choice"
          :disabled="
            disabled || commentBusy || (busy !== null && busy !== choice)
          "
          @click="busy === null && !commentBusy && emit('answer', choice)"
        >
          <span class="flex w-full items-center gap-2 font-semibold">
            <UIcon
              :name="
                busy === choice
                  ? 'i-lucide-loader-circle'
                  : CHOICES[choice].icon
              "
              class="size-5 shrink-0"
              :class="[
                busy === choice ? 'animate-spin' : '',
                answer === choice ? '' : ICON_COLORS[choice],
              ]"
              aria-hidden="true"
            />
            {{ t(`proponentReview.answer.${choice}`) }}
            <UKbd
              :value="CHOICES[choice].key"
              size="sm"
              class="ms-auto hidden lg:inline-flex"
              aria-hidden="true"
            />
          </span>
          <span class="text-xs font-normal opacity-90">
            {{ t(`proponentReview.answer.${choice}Help`) }}
          </span>
        </UButton>
      </div>
    </section>
  </article>
</template>
