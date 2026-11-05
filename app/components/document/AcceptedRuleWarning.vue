<script setup lang="ts">
import type { AcceptedAmendmentRule } from "~~/shared/constants/domain";

/**
 * What saving a new rule for accepted amendments does on a published
 * document (acceptedRuleChange): switching to "incorporate" approves what
 * the main presenter already accepted, without a vote; switching to "vote"
 * sends what its acceptance approved back to the vote. Shown before saving,
 * next to the choice and, while that section is folded, by the save button.
 */
const props = withDefaults(
  defineProps<{
    /** The rule the document switches to. */
    change: AcceptedAmendmentRule;
    /** The main presenter's acronym, when the document has one. */
    member?: string | null;
  }>(),
  { member: null },
);

const { t } = useI18n();

const description = computed(() =>
  t(`document.acceptedRule.change.${props.change}`, {
    member: props.member || t("document.acceptedRule.change.presenterFallback"),
  }),
);
</script>

<template>
  <UAlert
    color="warning"
    variant="subtle"
    icon="i-lucide-triangle-alert"
    :title="t('document.acceptedRule.change.title')"
    :description="description"
    role="status"
    data-testid="accepted-rule-warning"
  />
</template>
