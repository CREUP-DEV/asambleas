<script setup lang="ts">
import type { RouteLocationRaw } from "vue-router";
import type { AcceptedAmendmentRule } from "~~/shared/constants/domain";
import type { MemberRef } from "~~/shared/types/api";
import { formatDateTime } from "~/utils/format";
import {
  ANSWER_STATUS_ICONS,
  amendmentOutcome,
  answerStatus,
  isIncorporated,
  isPositionHidden,
  visibleAnswerProgress,
  type PositionWaitCounts,
  type ProponentReviewItem,
} from "./-review";

/**
 * What a co-presenter sees in the review mode: only the main presenter (or
 * the Mesa for it) answers the amendments, and this says so up front. Then a
 * calm list of every amendment the main presenter answered or answers now,
 * each with what it decided and when ("CEA-AC la aceptó el 5 nov 2026,
 * 10:30"), its comment, how the amendment ended once it is decided ("La
 * asamblea la rechazó."), and a link to the amendment in the document.
 * Nothing here can be changed. An answer hidden from the viewer says so
 * instead of passing for unanswered, and stays out of the progress line.
 *
 * Once the document is voted (`readOnly`) or withdrawn or postponed
 * (`closed`) it reads in the past tense, without the progress line or what
 * is still on its way.
 */
const props = withDefaults(
  defineProps<{
    items: ProponentReviewItem[];
    /** The main presenter: who answers. */
    presenter: MemberRef | null;
    /** What an accepted amendment becomes under the document's rule. */
    acceptedAmendments: AcceptedAmendmentRule;
    /** Amendments still on their way to the main presenter. */
    waiting?: PositionWaitCounts | null;
    /** Where an amendment opens in the document. */
    amendmentTo: (id: string) => RouteLocationRaw;
    /** Where "Volver al documento" goes. */
    documentTo: string;
    /** The document was voted: the answers are final. */
    readOnly?: boolean;
    /** The document was withdrawn or postponed. */
    closed?: boolean;
  }>(),
  { waiting: null, readOnly: false, closed: false },
);

const { t, locale } = useI18n();
const titleId = useId();

/** "CEA-AC", or a plain description when the document names no one. */
const presenterName = computed(
  () => props.presenter?.acronym ?? t("proponentReview.coPresenter.someone"),
);

/** Nothing can be answered any more: the page reads in the past tense. */
const settled = computed(() => props.readOnly || props.closed);

const alertTitle = computed(() =>
  t(
    settled.value
      ? "proponentReview.coPresenter.titleDone"
      : "proponentReview.coPresenter.title",
    { member: presenterName.value },
  ),
);

const alertDescription = computed(() => {
  if (props.readOnly) {
    return t("proponentReview.coPresenter.descriptionReadOnly");
  }
  if (props.closed) return t("proponentReview.coPresenter.descriptionClosed");
  return t(
    props.acceptedAmendments === "incorporate"
      ? "proponentReview.coPresenter.descriptionIncorporate"
      : "proponentReview.coPresenter.description",
    { member: presenterName.value },
  );
});

const progress = computed(() => visibleAnswerProgress(props.items));

const HIDDEN_ICON = { name: "i-lucide-eye-off", color: "text-dimmed" };

/** What the main presenter decided and when, as a sentence. */
function answerOf(item: ProponentReviewItem): {
  icon: { name: string; color: string };
  sentence: string;
  comment: string | null;
} {
  const { amendment } = item;
  const member = presenterName.value;
  // Hidden from the viewer; an incorporated one still says so by its status.
  if (isPositionHidden(amendment) && !isIncorporated(amendment)) {
    return {
      icon: HIDDEN_ICON,
      sentence: t("proponentReview.coPresenter.hidden", { member }),
      comment: null,
    };
  }
  const status = answerStatus(amendment);
  if (status === "pending") {
    return {
      icon: ANSWER_STATUS_ICONS.pending,
      sentence: t("proponentReview.coPresenter.pending", { member }),
      comment: null,
    };
  }
  const date = formatDateTime(amendment.position?.updatedAt, {
    locale: locale.value,
  });
  return {
    icon: ANSWER_STATUS_ICONS[status],
    sentence: date
      ? t(`proponentReview.coPresenter.answered.${status}`, { member, date })
      : t(`proponentReview.answers.${status}`),
    comment: amendment.position?.comment?.trim() || null,
  };
}

const rows = computed(() =>
  props.items.map((item) => {
    const outcome = amendmentOutcome(item.amendment);
    return {
      id: item.id,
      label:
        amendmentDisplayLabel(item.amendment) ?? t("proponentReview.noCode"),
      transactional: item.amendment.kind === "transactional",
      outcome: outcome
        ? t(`proponentReview.coPresenter.outcome.${outcome}`)
        : null,
      ...answerOf(item),
    };
  }),
);
</script>

<template>
  <section class="space-y-5" :aria-labelledby="titleId">
    <UAlert
      :color="settled ? 'neutral' : 'info'"
      variant="subtle"
      :icon="settled ? 'i-lucide-lock' : 'i-lucide-user-check'"
      :title="alertTitle"
      :description="alertDescription"
    />

    <div class="space-y-1">
      <h3 :id="titleId" class="text-highlighted font-semibold">
        {{
          settled
            ? t("proponentReview.coPresenter.listTitleDone")
            : t("proponentReview.coPresenter.listTitle")
        }}
      </h3>
      <template v-if="!settled">
        <p
          v-if="progress.total > 0"
          class="text-muted text-sm tabular-nums"
          aria-live="polite"
        >
          {{
            t(
              "proponentReview.progress.answered",
              { answered: progress.answered, total: progress.total },
              progress.total,
            )
          }}
        </p>
        <ProponentReviewWaiting v-if="waiting" :counts="waiting" reader />
      </template>
    </div>

    <CommonEmptyState
      v-if="rows.length === 0"
      icon="i-lucide-message-square-dashed"
      :title="
        settled
          ? t('proponentReview.coPresenter.emptyDone')
          : t('proponentReview.coPresenter.empty')
      "
      :description="
        settled
          ? t('proponentReview.coPresenter.emptyDoneDescription', {
              member: presenterName,
            })
          : t('proponentReview.coPresenter.emptyDescription')
      "
      variant="outline"
    />

    <ul v-else class="divide-default border-default divide-y rounded-lg border">
      <li v-for="row in rows" :key="row.id" class="space-y-1.5 px-4 py-3">
        <div class="flex flex-wrap items-center gap-2">
          <ULink
            :to="amendmentTo(row.id)"
            class="text-highlighted font-semibold tabular-nums hover:underline"
          >
            {{ row.label }}
          </ULink>
          <UBadge
            v-if="row.transactional"
            color="neutral"
            variant="outline"
            size="sm"
            :label="t('amendment.kinds.transactional')"
          />
        </div>
        <p class="text-default flex items-start gap-1.5 text-sm">
          <UIcon
            :name="row.icon.name"
            class="mt-0.5 size-4 shrink-0"
            :class="row.icon.color"
            aria-hidden="true"
          />
          <span>{{ row.sentence }}</span>
        </p>
        <p
          v-if="row.comment"
          class="text-muted border-default ms-5.5 border-s-2 ps-3 text-sm whitespace-pre-line"
        >
          <span class="sr-only">
            {{ t("proponentReview.coPresenter.comment") }}:
          </span>
          {{ row.comment }}
        </p>
        <p
          v-if="row.outcome"
          class="text-muted flex items-start gap-1.5 text-sm"
        >
          <UIcon
            name="i-lucide-gavel"
            class="mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          <span>{{ row.outcome }}</span>
        </p>
      </li>
    </ul>

    <div>
      <UButton
        :to="documentTo"
        icon="i-lucide-arrow-left"
        :label="t('proponentReview.back')"
      />
    </div>
  </section>
</template>
