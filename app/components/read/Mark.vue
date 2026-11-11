<script setup lang="ts">
import type { ReadState } from "~~/shared/types/api";

/**
 * Where a document or an amendment stands for the account, at a glance: a
 * dot while it is not read, "Con cambios" when it changed since it was
 * marked, and a quiet tick once read. The account's own ones (`own`) and
 * what takes no mark (`state` null) show nothing.
 */
const props = withDefaults(
  defineProps<{
    state: ReadState | null | undefined;
    kind: "document" | "amendment";
    own?: boolean;
    /** Leave the tick of a read one out (lists that only flag what is left). */
    hideRead?: boolean;
  }>(),
  { own: false, hideRead: false },
);

const { t } = useI18n();

const shown = computed<ReadState | null>(() => {
  if (!props.state || props.own) return null;
  if (props.state === "read" && props.hideRead) return null;
  return props.state;
});
</script>

<template>
  <UBadge
    v-if="shown === 'changed'"
    color="warning"
    variant="subtle"
    size="sm"
    icon="i-lucide-refresh-cw"
    :label="t(`readMarks.changed.${kind}`)"
    data-testid="read-mark"
    data-state="changed"
  />
  <span
    v-else-if="shown === 'unread'"
    class="inline-flex shrink-0 items-center"
    :title="t(`readMarks.unread.${kind}`)"
    data-testid="read-mark"
    data-state="unread"
  >
    <span class="bg-primary size-2 rounded-full" aria-hidden="true" />
    <span class="sr-only">{{ t(`readMarks.unread.${kind}`) }}</span>
  </span>
  <span
    v-else-if="shown === 'read'"
    class="text-muted inline-flex shrink-0 items-center"
    :title="t(`readMarks.read.${kind}`)"
    data-testid="read-mark"
    data-state="read"
  >
    <UIcon name="i-lucide-check" class="size-4" aria-hidden="true" />
    <span class="sr-only">{{ t(`readMarks.read.${kind}`) }}</span>
  </span>
</template>
