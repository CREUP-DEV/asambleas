<script setup lang="ts">
import type { VoteDto } from "~~/shared/types/api";
import { isUnanimousVote } from "~~/shared/utils/controlSheet";

/**
 * One recorded vote in a cell of the control sheet: how it was voted, every
 * count that is not zero (blank and invalid ones too, as the minutes record
 * them) and its result. `label` names what was voted when a row holds
 * several (the reference of each document).
 */
const props = defineProps<{
  vote: VoteDto;
  label?: string | null;
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
  <div class="space-y-0.5 text-sm">
    <div class="flex flex-wrap items-center gap-1.5">
      <span v-if="label" class="text-highlighted font-medium">{{ label }}</span>
      <CommonStatusBadge
        kind="vote"
        :value="vote.result"
        size="xs"
        :label="
          unanimous ? t('controlSheet.result.approved_unanimous') : undefined
        "
      />
      <span class="text-muted">{{
        t(`amendment.vote.methods.${vote.method}`)
      }}</span>
    </div>
    <p v-if="counts" class="text-muted tabular-nums">{{ counts }}</p>
  </div>
</template>
