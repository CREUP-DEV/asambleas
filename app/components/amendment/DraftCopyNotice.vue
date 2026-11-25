<script setup lang="ts">
/**
 * One quiet line inside a composer when this browser kept work it had not
 * saved (`useDraftCopy`): when it was written, «Recuperar» and «Descartar».
 * Never an alert: nothing is wrong, and it goes as soon as the author
 * answers or starts writing anew.
 */
const props = defineProps<{ savedAt: string }>();
const emit = defineEmits<{ recover: []; discard: [] }>();

const { t, locale } = useI18n();
const now = useAppNow();
const when = computed(() =>
  // Never in the future: the shared clock ticks once a minute.
  formatRelative(props.savedAt, {
    locale: locale.value,
    now: Math.max(now.value, Date.parse(props.savedAt) || 0),
  }),
);
</script>

<template>
  <p
    class="text-muted flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
    data-testid="composer-draft-copy"
  >
    <span class="flex min-w-0 items-start gap-1.5">
      <UIcon
        name="i-lucide-history"
        class="mt-0.5 size-4 shrink-0"
        aria-hidden="true"
      />
      {{ t("amendment.composer.copy.notice", { when }) }}
    </span>
    <span class="flex items-center gap-3">
      <UButton
        variant="link"
        size="sm"
        class="p-0"
        :label="t('amendment.composer.copy.recover')"
        @click="emit('recover')"
      />
      <UButton
        variant="link"
        color="neutral"
        size="sm"
        class="p-0"
        :label="t('amendment.composer.copy.discard')"
        @click="emit('discard')"
      />
    </span>
  </p>
</template>
