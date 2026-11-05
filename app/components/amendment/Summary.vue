<script setup lang="ts">
import type { AmendmentDto } from "~~/shared/types/api";
import {
  transactionalLinksOf,
  transactionalRejectedBy,
} from "~/composables/amendment/transactional";
import { useTransactionalProgressText } from "~/composables/amendment/useTransactionalProgressText";
import { amendmentAuthorsInOrder } from "~/composables/amendment/workspace";

/**
 * Compact amendment card with its outcome: label, presenting members (the
 * main author first), kind (when not the usual partial one), status, how it
 * was approved (an amendment the main presenter accepted under the
 * "incorporate" rule says so in plain words, naming the Mesa when it
 * recorded that answer) and the vote counts. The transactional that
 * replaced it is named only once it did (`byId` tells a replacement from a
 * proposal). A transactional a main author rejected says
 * who did, from its acceptances (its outcome note is left for the Mesa's
 * own words), instead of a bare "Retirada". Used in the consolidated
 * text popover and its annex. The default slot adds actions.
 */
const props = withDefaults(
  defineProps<{
    amendment: AmendmentDto;
    label: string;
    labelOf?: (id: string) => string;
    /** Every amendment of the document, for its transactional links. */
    byId?: ReadonlyMap<string, AmendmentDto>;
    /** Heading level of the label, for the page outline. */
    headingLevel?: 2 | 3 | 4;
    showJustification?: boolean;
  }>(),
  {
    labelOf: undefined,
    byId: undefined,
    headingLevel: 3,
    showJustification: false,
  },
);

const { t, locale } = useI18n();

const heading = computed(() => `h${props.headingLevel}`);
const { join } = useTransactionalProgressText();
/** "CEUM y CAUB" when main authors' rejections closed it, else "". */
const rejectedBy = computed(() =>
  join(
    transactionalRejectedBy(props.amendment).map((member) => member.acronym),
  ),
);
const authors = computed(() => amendmentAuthorsInOrder(props.amendment));
/** "Aprobada sin votación…" or "Aprobada por votación". */
const approvedText = computed(() => {
  const method = props.amendment.approvalMethod;
  if (props.amendment.status !== "approved" || !method) return null;
  if (method === "proponent") {
    return props.amendment.position?.recordedBy === "mesa"
      ? t("amendment.detail.approvedByMesa")
      : t("amendment.detail.approvedByPresenter");
  }
  return t("amendment.detail.approvedBy", {
    method: t(`amendment.approvalMethods.${method}`),
  });
});

/** "Transaccionada en" once replaced; the open ones while only proposed. */
const links = computed(() =>
  props.byId
    ? transactionalLinksOf(props.amendment, props.byId)
    : {
        replacedBy:
          props.amendment.status === "transacted"
            ? props.amendment.transactionalIds
            : [],
        proposed: [],
      },
);
const transactedIn = computed(() =>
  props.labelOf
    ? links.value.replacedBy.map((id) => props.labelOf!(id)).join(", ")
    : "",
);
const proposedIn = computed(() =>
  props.labelOf
    ? links.value.proposed.map((id) => props.labelOf!(id)).join(", ")
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
      <!-- Closed by a main author's rejection: the line below says so. -->
      <CommonStatusBadge
        v-if="!rejectedBy"
        kind="amendment"
        :value="amendment.status"
        size="xs"
        class="ms-auto"
      />
    </div>

    <div
      v-if="
        amendment.kind !== 'partial' ||
        amendment.changeKinds.length > 0 ||
        amendment.late
      "
      class="flex flex-wrap items-center gap-1"
    >
      <!-- "Parcial" is the usual kind: only the others are worth a badge. -->
      <UBadge
        v-if="amendment.kind !== 'partial'"
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

    <p v-if="rejectedBy" class="text-muted text-sm">
      {{ t("amendment.detail.rejectedByAuthors", { members: rejectedBy }) }}
      <template v-if="amendment.decidedAt">
        · {{ formatDateTime(amendment.decidedAt, { locale }) }}
      </template>
    </p>
    <p v-else-if="approvedText" class="text-muted text-sm">
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
    <p v-if="proposedIn" class="text-muted text-sm">
      {{
        t(
          "amendment.card.proposedIn",
          { list: proposedIn },
          links.proposed.length,
        )
      }}
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
