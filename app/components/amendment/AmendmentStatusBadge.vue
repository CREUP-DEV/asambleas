<script setup lang="ts">
const { t } = useI18n();

const props = defineProps<{
  status: string;
  type?: string;
}>();

const badgeColor = computed(() => {
  switch (props.status) {
    case "draft":
      return "neutral" as const;
    case "pending_review":
      return "warning" as const;
    case "rejected_secretaria":
    case "rejected_proponent":
    case "rejected_vote":
      return "error" as const;
    case "formal":
      return "info" as const;
    case "accepted_secretaria":
      return "warning" as const;
    case "accepted_proponent":
    case "approved_vote":
      return "success" as const;
    default:
      return "neutral" as const;
  }
});
</script>

<template>
  <UBadge :color="badgeColor" variant="subtle" size="sm">
    {{ t(`amendment.statuses.${status}`) }}
  </UBadge>
</template>
