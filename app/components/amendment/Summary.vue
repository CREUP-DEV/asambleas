<script setup lang="ts">
import type { AmendmentDto } from "~~/shared/types/api";

/**
 * Compact amendment card with its outcome: label, presenting members, kind,
 * status, how it was approved and the vote counts. Used in the consolidated
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
      <CommonMemberBadge
        v-for="author in amendment.authors"
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

    <p
      v-if="amendment.status === 'approved' && amendment.approvalMethod"
      class="text-muted text-sm"
    >
      {{
        t("amendment.detail.approvedBy", {
          method: t(`amendment.approvalMethods.${amendment.approvalMethod}`),
        })
      }}
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
