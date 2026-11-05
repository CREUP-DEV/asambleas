<script setup lang="ts">
/**
 * The review's keyboard shortcuts, in a popover. They act on the amendment
 * on screen (a transactional included) and do nothing while a comment is
 * being typed.
 */
const { t } = useI18n();

const SHORTCUTS = [
  { keys: ["a"], key: "accept" },
  { keys: ["r"], key: "reject" },
  { keys: ["t"], key: "transact" },
  { keys: ["j"], key: "next" },
  { keys: ["k"], key: "previous" },
] as const;
</script>

<template>
  <UPopover>
    <UButton
      color="neutral"
      variant="ghost"
      icon="i-lucide-keyboard"
      :label="t('proponentReview.shortcuts.button')"
    />
    <template #content>
      <div class="w-72 space-y-2 p-3">
        <p class="text-highlighted text-sm font-medium">
          {{ t("proponentReview.shortcuts.button") }}
        </p>
        <dl class="space-y-1.5 text-sm">
          <div
            v-for="shortcut in SHORTCUTS"
            :key="shortcut.key"
            class="flex items-center justify-between gap-3"
          >
            <dt class="text-default">
              {{ t(`proponentReview.shortcuts.${shortcut.key}`) }}
            </dt>
            <dd class="flex gap-1">
              <UKbd v-for="key in shortcut.keys" :key="key" :value="key" />
            </dd>
          </div>
        </dl>
        <p class="text-muted text-xs">
          {{ t("proponentReview.shortcuts.hint") }}
        </p>
      </div>
    </template>
  </UPopover>
</template>
