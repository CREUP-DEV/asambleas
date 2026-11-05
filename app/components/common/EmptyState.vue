<script setup lang="ts">
/**
 * Empty, "nothing here yet" state: icon, title, description, optional extra
 * content (default slot) and an optional `action` slot (buttons), in that
 * order. Wraps UEmpty so every screen looks the same.
 *
 * UEmpty's `body` slot replaces its actions row, so when there is extra
 * content the actions are rendered inside the body, after it, with the same
 * classes UEmpty gives its actions row.
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
      <div
        v-if="$slots.action"
        data-slot="actions"
        class="flex shrink-0 flex-wrap justify-center gap-2"
      >
        <slot name="action" />
      </div>
    </template>
    <template v-else-if="$slots.action" #actions>
      <slot name="action" />
    </template>
  </UEmpty>
</template>
