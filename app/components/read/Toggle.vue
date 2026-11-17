<script setup lang="ts">
/**
 * The account's read mark of a published document or amendment. Reading
 * one to its end marks it read (useAutoReadMark), so the button mostly
 * takes that back («Marcar como no leído»); before that, or once taken
 * back, it marks it read.
 * Nothing shows for what takes no mark (a draft, something not published)
 * or before the marks load.
 */
const props = withDefaults(
  defineProps<{
    kind: "document" | "amendment";
    id: string;
    size?: "xs" | "sm" | "md";
  }>(),
  { size: "sm" },
);

const emit = defineEmits<{
  /** Saved: `read` is the new state. */
  change: [read: boolean];
}>();

const { t } = useI18n();
const marks = useReadMarks();

const mark = computed(() =>
  props.kind === "document"
    ? marks.document(props.id)
    : marks.amendment(props.id),
);
const read = computed(() => mark.value?.state === "read");
const busy = ref(false);
const announcement = ref("");

async function toggle(): Promise<void> {
  if (busy.value) return;
  const next = !read.value;
  busy.value = true;
  try {
    const saved = await marks.set(
      props.kind === "document"
        ? { documentIds: [props.id] }
        : { amendmentIds: [props.id] },
      next,
    );
    if (!saved) return;
    announcement.value = t(
      next
        ? `readMarks.marked.${props.kind}`
        : `readMarks.unmarked.${props.kind}`,
    );
    emit("change", next);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <span v-if="mark" class="inline-flex">
    <UButton
      :size="size"
      color="neutral"
      :variant="read ? 'ghost' : 'soft'"
      :icon="read ? 'i-lucide-eye-off' : 'i-lucide-check'"
      :label="
        read ? t(`readMarks.unmark.${kind}`) : t(`readMarks.mark.${kind}`)
      "
      :loading="busy"
      data-testid="read-toggle"
      @click="toggle"
    />
    <span class="sr-only" aria-live="polite" role="status">
      {{ announcement }}
    </span>
  </span>
</template>
