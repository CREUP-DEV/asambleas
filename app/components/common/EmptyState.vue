<script setup lang="ts">
/**
 * Empty, "nothing here yet" state: icon, title, description and an optional
 * `action` slot (buttons). Wraps UEmpty so every screen looks the same.
 */
withDefaults(
  defineProps<{
    icon?: string;
    title: string;
    description?: string;
    size?: "xs" | "sm" | "md" | "lg" | "xl";
    variant?: "solid" | "outline" | "soft" | "subtle" | "naked";
  }>(),
  {
    icon: "i-lucide-inbox",
    description: undefined,
    size: "md",
    variant: "naked",
  },
);

defineSlots<{
  /** Call to action, usually one or two UButton. */
  action?: () => unknown;
  /** Extra content under the description. */
  default?: () => unknown;
}>();
</script>

<template>
  <UEmpty
    :icon="icon"
    :title="title"
    :description="description"
    :size="size"
    :variant="variant"
    role="status"
  >
    <template v-if="$slots.default" #body>
      <slot />
    </template>
    <template v-if="$slots.action" #actions>
      <slot name="action" />
    </template>
  </UEmpty>
</template>
