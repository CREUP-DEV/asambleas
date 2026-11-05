<script setup lang="ts">
/**
 * A short yes-or-no question before a console action that cannot be undone
 * or that shows something to the whole room. Opened through useOverlay (see
 * the console's `confirm`): it closes with `true` when confirmed and with
 * `false` (or nothing) when cancelled or dismissed.
 */
withDefaults(
  defineProps<{
    title: string;
    description: string;
    /** Amendment codes the action applies to, listed under the question. */
    items?: string[];
    confirmLabel: string;
    confirmIcon?: string;
    confirmColor?: "primary" | "warning" | "error";
  }>(),
  { items: () => [], confirmIcon: undefined, confirmColor: "primary" },
);

const emit = defineEmits<{ close: [confirmed: boolean] }>();

const { t } = useI18n();
</script>

<template>
  <UModal
    :title="title"
    :description="description"
    :close="{ onClick: () => emit('close', false) }"
  >
    <template v-if="items.length > 0" #body>
      <ul
        class="flex flex-wrap gap-1.5"
        :aria-label="t('session.confirm.items')"
      >
        <li v-for="item in items" :key="item">
          <UBadge
            color="neutral"
            variant="outline"
            class="tabular-nums"
            :label="item"
          />
        </li>
      </ul>
    </template>
    <template #footer>
      <div class="flex w-full flex-wrap justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :label="t('common.cancel')"
          @click="emit('close', false)"
        />
        <UButton
          :color="confirmColor"
          :icon="confirmIcon"
          :label="confirmLabel"
          @click="emit('close', true)"
        />
      </div>
    </template>
  </UModal>
</template>
