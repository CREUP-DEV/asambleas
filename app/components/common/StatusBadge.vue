<script setup lang="ts">
import {
  statusColor,
  statusLabelKey,
  type StatusKind,
} from "~/utils/statusColors";

/**
 * Coloured badge for a domain status (assembly, document, amendment,
 * admission, proponent position, vote result, transactional acceptance),
 * in the colour of the one status map (`app/utils/statusColors.ts`).
 * Unknown values fall back to a neutral badge with the raw value. `label`
 * words it otherwise (who answered, say), keeping the status colour. At
 * 12px (`md`) unless the caller asks otherwise: the theme's `sm` and `xs`
 * are 10px and 8px.
 */
const props = withDefaults(
  defineProps<{
    kind: StatusKind;
    value: string;
    size?: "xs" | "sm" | "md" | "lg" | "xl";
    variant?: "solid" | "outline" | "soft" | "subtle";
    icon?: string;
    /** Overrides the translated status label. */
    label?: string;
  }>(),
  { size: "md", variant: "subtle", icon: undefined, label: undefined },
);

const { t, te } = useI18n();

const color = computed(() => statusColor(props.kind, props.value));

const resolvedLabel = computed(() => {
  if (props.label) return props.label;
  const key = statusLabelKey(props.kind, props.value);
  return te(key) ? t(key) : props.value;
});
</script>

<template>
  <UBadge
    :color="color"
    :variant="variant"
    :size="size"
    :icon="icon"
    :label="resolvedLabel"
    :data-status="`${kind}:${value}`"
    class="whitespace-nowrap"
  />
</template>
