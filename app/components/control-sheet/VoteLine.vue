<script setup lang="ts">
import type { VoteDto } from "~~/shared/types/api";
import { isUnanimousVote } from "~~/shared/utils/controlSheet";

/**
 * One recorded vote in a cell of the control sheet: how it was voted, every
 * count that is not zero (blank and invalid ones too, as the minutes record
 * them) and its result. `label` names what was voted when it helps (the
 * title of each document when a row holds several, the question of a vote
 * on the item), on a line of its own; `clamp` cuts a long one to three
 * lines, as the lists do. A `voided` vote reads «Anulada», dimmed and
 * struck through: it stays for the record and decides nothing.
 */
const props = defineProps<{
  vote: VoteDto;
  label?: string | null;
  clamp?: boolean;
  voided?: boolean;
}>();

const { t } = useI18n();

const counts = computed(() => {
  if (props.vote.method === "assent") return "";
  const parts: string[] = [
    `${t("amendment.vote.inFavor")} ${props.vote.inFavor}`,
    `${t("amendment.vote.against")} ${props.vote.against}`,
    `${t("amendment.vote.abstentions")} ${props.vote.abstentions}`,
  ];
  if (props.vote.blank > 0) {
    parts.push(`${t("amendment.vote.blank")} ${props.vote.blank}`);
  }
  if (props.vote.invalid > 0) {
    parts.push(`${t("amendment.vote.invalid")} ${props.vote.invalid}`);
  }
  return parts.join(" · ");
});

const unanimous = computed(() => isUnanimousVote(props.vote));
</script>

<template>
  <div :class="['space-y-0.5 text-sm', voided ? 'opacity-70' : '']">
    <p
      v-if="label"
      :class="[
        'text-highlighted font-medium break-words',
        clamp ? 'line-clamp-3' : '',
        voided ? 'line-through' : '',
      ]"
      :title="clamp ? label : undefined"
    >
      {{ label }}
    </p>
    <div class="flex flex-wrap items-center gap-1.5">
      <UBadge
        v-if="voided"
        color="neutral"
        variant="outline"
        size="sm"
        :label="t('controlSheet.itemVotes.voided')"
      />
      <CommonStatusBadge
        kind="vote"
        :value="vote.result"
        size="xs"
        :label="
          unanimous ? t('controlSheet.result.approved_unanimous') : undefined
        "
        :class="voided ? 'line-through' : ''"
      />
      <span :class="['text-muted', voided ? 'line-through' : '']">{{
        t(`amendment.vote.methods.${vote.method}`)
      }}</span>
    </div>
    <p
      v-if="counts"
      :class="['text-muted tabular-nums', voided ? 'line-through' : '']"
    >
      {{ counts }}
    </p>
  </div>
</template>
