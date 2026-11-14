<script setup lang="ts">
/**
 * Whether a row was treated: a check with its word for screen readers, or
 * a quiet «Pendiente». `feminine` words it for an amendment («Tratada»).
 */
defineProps<{
  treated: boolean;
  feminine?: boolean;
}>();

const { t } = useI18n();
</script>

<template>
  <span
    v-if="treated"
    class="text-default inline-flex items-center gap-1 text-sm"
  >
    <UIcon
      name="i-lucide-circle-check"
      class="text-success size-4 shrink-0"
      aria-hidden="true"
    />
    {{
      t(
        feminine
          ? "controlSheet.treated.yesAmendment"
          : "controlSheet.treated.yes",
      )
    }}
  </span>
  <span v-else class="text-dimmed text-sm">{{
    t("controlSheet.treated.no")
  }}</span>
</template>
