<script setup lang="ts">
import type { AmendmentDto } from "~~/shared/types/api";
import { amendmentAuthorsInOrder } from "~/composables/amendment/workspace";

/**
 * Compact amendment card with its outcome: label, presenting members (the
 * main author first), kind, status, how it was approved (an amendment the
 * main presenter accepted under the "incorporate" rule says so in plain
 * words) and the vote counts. Used in the consolidated
 * text popover and its annex. The default slot adds actions.
 */
const props = withDefaults(
  defineProps<{
    amendment: AmendmentDto;
    label: string;
    labelOf?: (id: string) => string;
    /** Heading level of the label, for the page outline. */
    headingLevel?: 2 | 3 | 4;
    showJustification?: boolean;
  }>(),
  { labelOf: undefined, headingLevel: 3, showJustification: false },
);

const { t, locale } = useI18n();

const heading = computed(() => `h${props.headingLevel}`);
const authors = computed(() => amendmentAuthorsInOrder(props.amendment));
/** "Aprobada sin votación…" or "Aprobada por votación". */
const approvedText = computed(() => {
  const method = props.amendment.approvalMethod;
  if (props.amendment.status !== "approved" || !method) return null;
  return method === "proponent"
    ? t("amendment.detail.approvedByPresenter")
    : t("amendment.detail.approvedBy", {
        method: t(`amendment.approvalMethods.${method}`),
      });
});

const transactedIn = computed(() =>
  props.labelOf
    ? props.amendment.transactionalIds
        .map((id) => props.labelOf!(id))
        .join(", ")
    : "",
);
const sources = computed(() =>
  props.labelOf
    ? props.amendment.sourceIds.map((id) => props.labelOf!(id)).join(", ")
    : "",
);
</script>

<template>
  <div class="flex min-w-0 flex-col gap-2">
    <div class="flex flex-wrap items-center gap-1.5">
      <component
        :is="heading"
        class="text-highlighted text-sm font-semibold tabular-nums"
      >
        {{ label }}
      </component>
      <template v-if="authors.main">
        <CommonMemberBadge :member="authors.main" size="xs" />
        <span v-if="authors.marked" class="text-dimmed text-xs">
          {{ t("amendment.card.mainAuthor") }}
        </span>
      </template>
      <CommonMemberBadge
        v-for="author in authors.others"
        :key="author.id"
        :member="author"
        size="xs"
      />
      <CommonStatusBadge
        kind="amendment"
        :value="amendment.status"
        size="xs"
        class="ms-auto"
      />
    </div>

    <div class="flex flex-wrap items-center gap-1">
      <UBadge
        color="neutral"
        variant="outline"
        size="xs"
        :label="t(`amendment.kinds.${amendment.kind}`)"
      />
      <UBadge
        v-for="change in amendment.changeKinds"
        :key="change"
        color="neutral"
        variant="soft"
        size="xs"
        :label="t(`amendment.changeKinds.${change}`)"
      />
      <UBadge
        v-if="amendment.late"
        color="warning"
        variant="subtle"
        size="xs"
        :label="t('amendment.late')"
      />
    </div>

    <p v-if="approvedText" class="text-muted text-sm">
      {{ approvedText }}
      <template v-if="amendment.decidedAt">
        · {{ formatDateTime(amendment.decidedAt, { locale }) }}
      </template>
    </p>
    <p v-else-if="amendment.decidedAt" class="text-muted text-sm">
      {{
        t("amendment.detail.decidedAt", {
          date: formatDateTime(amendment.decidedAt, { locale }),
        })
      }}
    </p>

    <AmendmentVoteSummary
      v-if="amendment.outcomeVote"
      :vote="amendment.outcomeVote"
      compact
    />

    <p v-if="sources" class="text-muted text-sm">
      {{ t("amendment.card.sources", { list: sources }) }}
    </p>
    <p v-if="transactedIn" class="text-muted text-sm">
      {{ t("amendment.card.transactedIn", { list: transactedIn }) }}
    </p>
    <p
      v-if="amendment.outcomeNote"
      class="text-muted text-sm whitespace-pre-line"
    >
      {{ amendment.outcomeNote }}
    </p>
    <p
      v-if="showJustification && amendment.justification"
      class="text-default line-clamp-4 text-sm whitespace-pre-line"
    >
      {{ amendment.justification }}
    </p>

    <slot />
  </div>
</template>
