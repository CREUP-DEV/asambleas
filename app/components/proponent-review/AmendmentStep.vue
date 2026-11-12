<script setup lang="ts">
import type { RouteLocationRaw } from "vue-router";
import type { AcceptedAmendmentRule } from "~~/shared/constants/domain";
import type { AmendmentDto, MemberRef } from "~~/shared/types/api";
import type { Block } from "~~/shared/types/content";
import { NOTE_MAX_LENGTH } from "~~/shared/utils/schemas/amendment";
import {
  amendmentAuthorsInOrder,
  type AmendmentRelationView,
} from "~/composables/amendment/workspace";
import {
  PROPONENT_ANSWERS,
  acceptHelpKey,
  acceptIncorporates,
  isIncorporated,
  positionAnswer,
  stateKey,
  type ProponentAnswer,
} from "./-review";

/**
 * One amendment of the main presenter's review: its code, who presents it
 * (with co-authors, the main author is marked: it is the one who accepts a
 * transactional), where it stands as a sentence with the next step (and who
 * answered, when the Mesa did it for the main presenter), the change in
 * large type, its justification, and the answer: an optional comment and
 * three choices (Aceptar, Rechazar, Transaccionar). Pressing a choice saves
 * it with the comment; the page then moves on. The saved choice shows as
 * pressed and can be changed until the amendment is decided (never after
 * the document's final vote, when the page stops showing steps).
 *
 * "Aceptar" says what accepting means under the document's rule: put in
 * the text without a vote ("incorporate") or voted by the assembly. An
 * amendment already incorporated can still change its answer before the
 * final vote, which takes it out of the text again (the other choices say
 * so). Once answered, a changed comment gets its own "Guardar comentario",
 * which keeps the answer and stays on the amendment. After "Transaccionar",
 * "Proponer la transaccional" opens the composer of the workspace on this
 * amendment (when it can be combined).
 *
 * Under where it stands, one quiet line each for what the document page
 * also shows: a pending transactional over it (which would replace it) and
 * its relations with other amendments ("Incompatible con 5 · UGR 1").
 * When accepting would incorporate it at once (acceptIncorporates), they
 * also say what that sets off: the overlapping amendments already in the
 * text it clashes with ("Choca con 12 · CEUM 4, ya incorporada"), the
 * pending transactionals it withdraws (back if the answer changes before
 * the final vote), and, under "Aceptar", that everyone sees the approval
 * while the answers are still reserved.
 *
 * A transactional lists the amendments it replaced; their changes fold
 * away.
 */
const props = withDefaults(
  defineProps<{
    amendment: AmendmentDto;
    base: Block[];
    /** What an accepted amendment becomes under the document's rule. */
    acceptedAmendments: AcceptedAmendmentRule;
    /** For a transactional: the amendments it replaced, as the actor sees them. */
    sources?: AmendmentDto[];
    /**
     * Transactionals over this amendment still on their way, the ones the
     * viewer can see (`transactionalIds`): one still unpublished and
     * waiting for its parties is not named, though accepting under
     * "incorporate" withdraws it too (and changing the answer brings it
     * back).
     */
    pendingTransactionals?: AmendmentDto[];
    /** Its relations with other amendments of the document. */
    relations?: AmendmentRelationView[];
    /**
     * Approved amendments it overlaps with, while accepting would
     * incorporate it (incorporatedClashIds).
     */
    clashIds?: string[];
    /** The answers are still reserved (answersReserved). */
    answersReserved?: boolean;
    /** "12 · CEUM 4" for an amendment id. */
    labelOf?: ((id: string) => string) | null;
    /** The choice being saved, if any. */
    busy?: ProponentAnswer | null;
    disabled?: boolean;
    /** The Mesa answers for this member (the document's main presenter). */
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
    sources: () => [],
    pendingTransactionals: () => [],
    relations: () => [],
    clashIds: () => [],
    answersReserved: false,
    labelOf: null,
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
/** The keys are shown only while this browser keeps them on. */
const { enabled: shortcutsEnabled } = useSingleKeyShortcuts();
const titleId = useId();
const answerId = useId();
const heading = useTemplateRef<HTMLElement>("heading");

const label = computed(
  () => amendmentDisplayLabel(props.amendment) ?? t("proponentReview.noCode"),
);
const answer = computed(() => positionAnswer(props.amendment));
/** Accepted and already in the text, without a vote. */
const incorporated = computed(() => isIncorporated(props.amendment));
/** Accepting approves it at once, with what that sets off. */
const incorporates = computed(() =>
  acceptIncorporates(props.amendment, props.acceptedAmendments),
);

/**
 * How the main presenter the Mesa answers for is named, the same in the
 * notice above the answer and in the state sentence: by its acronym, as
 * everywhere else in the review.
 */
const onBehalfName = computed(() => props.onBehalfOf?.acronym ?? "");

/**
 * Where it stands, and what happens next under the document's rule; for the
 * Mesa answering for the main presenter, naming that member. An answer the
 * Mesa recorded on the member's behalf says so ("La Mesa, en tu nombre, la
 * ha aceptado", or "La Mesa, en nombre de CEUM, ..." for the Mesa).
 */
const stateSentence = computed(() =>
  t(
    `proponentReview.state.${stateKey(
      props.amendment,
      props.acceptedAmendments,
      Boolean(props.onBehalfOf),
    )}`,
    { member: onBehalfName.value },
  ),
);

/**
 * The authors, main one first. With co-authors the main one is marked: it
 * is the one who accepts or rejects a transactional over this amendment.
 */
const authors = computed(() => amendmentAuthorsInOrder(props.amendment));
/** With co-authors, the main one, to name it in "Transaccionar". */
const mainAuthor = computed(() =>
  authors.value.marked ? authors.value.main : null,
);

/** Under each choice: what it means, and what it undoes. */
function choiceHelp(choice: ProponentAnswer): string {
  if (choice === "accept") {
    const help = t(
      `proponentReview.answer.${acceptHelpKey(props.acceptedAmendments)}`,
    );
    return incorporates.value && props.answersReserved
      ? `${help} ${t("proponentReview.answer.acceptRevealsApproval")}`
      : help;
  }
  const help =
    choice === "transact" && mainAuthor.value
      ? t("proponentReview.answer.transactHelpMain", {
          member: mainAuthor.value.acronym,
        })
      : t(`proponentReview.answer.${choice}Help`);
  return incorporated.value
    ? `${help} ${t("proponentReview.answer.reopenHelp")}`
    : help;
}

/** The amendments a transactional replaced, by label. */
const replaced = computed(() =>
  props.amendment.kind === "transactional"
    ? props.amendment.sourceIds.map((id) => ({
        id,
        label: props.labelOf?.(id) ?? t("proponentReview.noCode"),
      }))
    : [],
);
const sourcesOpen = ref(false);

/** "12 · CEUM 4" for another amendment of the document. */
function otherLabel(id: string): string {
  return props.labelOf?.(id) ?? t("proponentReview.noCode");
}

/**
 * The context lines under where it stands: the amendments already in the
 * text it clashes with, a pending transactional over it (one line for all
 * of them; accepting withdraws it when that incorporates the amendment) and
 * each relation, worded as in the document's amendment cards.
 */
const context = computed(() => {
  const lines: { key: string; icon: string; text: string }[] = [];
  if (props.clashIds.length > 0) {
    lines.push({
      key: "clashes",
      icon: "i-lucide-layers",
      text: t(
        "proponentReview.context.clashIncorporated",
        { list: props.clashIds.map(otherLabel).join(", ") },
        props.clashIds.length,
      ),
    });
  }
  const pending = props.pendingTransactionals;
  if (pending.length > 0) {
    lines.push({
      key: "pending-transactionals",
      icon: "i-lucide-git-merge",
      text: t(
        incorporates.value
          ? "proponentReview.context.pendingTransactionalIncorporate"
          : "proponentReview.context.pendingTransactional",
        { list: pending.map((item) => otherLabel(item.id)).join(", ") },
        pending.length,
      ),
    });
  }
  for (const view of props.relations) {
    const kind =
      view.direction === "from"
        ? `amendment.relations.kinds.${view.relation.kind}`
        : `amendment.relations.inverse.${view.relation.kind}`;
    lines.push({
      key: view.relation.id,
      icon: "i-lucide-link-2",
      text: `${t(kind)} ${otherLabel(view.otherId)}`,
    });
  }
  return lines;
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
        <template v-if="authors.main">
          <CommonMemberBadge
            :member="authors.main"
            :show-name="!authors.marked"
          />
          <span v-if="authors.marked" class="text-dimmed text-xs">
            {{ t("proponentReview.mainAuthor") }}
          </span>
        </template>
        <CommonMemberBadge
          v-for="author in authors.others"
          :key="author.id"
          :member="author"
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
      <ul v-if="context.length > 0" class="text-muted space-y-1 text-sm">
        <li
          v-for="line in context"
          :key="line.key"
          class="flex items-start gap-1.5"
        >
          <UIcon
            :name="line.icon"
            class="mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          <span>{{ line.text }}</span>
        </li>
      </ul>
    </header>

    <section v-if="replaced.length > 0" class="space-y-2">
      <h4 class="text-highlighted text-sm font-semibold">
        {{ t("proponentReview.transactional.replaces") }}
      </h4>
      <ul class="flex flex-wrap gap-1.5">
        <li v-for="source in replaced" :key="source.id">
          <UBadge
            color="neutral"
            variant="subtle"
            class="tabular-nums"
            :label="source.label"
          />
        </li>
      </ul>
      <UCollapsible
        v-if="sources.length > 0"
        v-model:open="sourcesOpen"
        class="space-y-3"
      >
        <UButton
          color="neutral"
          variant="link"
          size="sm"
          class="px-0"
          :trailing-icon="
            sourcesOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'
          "
          :label="
            sourcesOpen
              ? t('proponentReview.transactional.hideSources')
              : t('proponentReview.transactional.showSources')
          "
        />
        <template #content>
          <div class="space-y-4">
            <ProponentReviewChange
              v-for="source in sources"
              :key="source.id"
              :amendment="source"
              :base="base"
              :title="labelOf?.(source.id)"
              compact
            />
          </div>
        </template>
      </UCollapsible>
    </section>

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
        {{ t("proponentReview.onBehalf", { member: onBehalfName }) }}
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
          :aria-keyshortcuts="
            shortcutsEnabled ? CHOICES[choice].key : undefined
          "
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
              v-if="shortcutsEnabled"
              :value="CHOICES[choice].key"
              size="sm"
              class="ms-auto hidden lg:inline-flex"
              aria-hidden="true"
            />
          </span>
          <span class="text-xs font-normal opacity-90">
            {{ choiceHelp(choice) }}
          </span>
        </UButton>
      </div>
    </section>
  </article>
</template>
