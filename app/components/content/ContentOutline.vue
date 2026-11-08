<script setup lang="ts">
import type { OutlineEntry } from "./ContentView.vue";

/**
 * The index of a text where there is no margin for its marks (narrow
 * screens): a burgundy button floating over the text, ringed in the page's
 * colour so it stands out on a burgundy heading too, that opens the headings
 * (ContentOutlineList). The section being read is marked when it opens.
 */
const props = defineProps<{
  items: OutlineEntry[];
  /** The id of the heading of the section being read. */
  current?: () => string | null;
}>();

const emit = defineEmits<{ select: [blockId: string] }>();

const { t } = useI18n();

const open = ref(false);
const active = ref<string | null>(null);

watch(open, (value) => {
  if (value) active.value = props.current?.() ?? null;
});

function pick(id: string): void {
  open.value = false;
  // After the popover has closed and handed the focus back.
  void nextTick(() => emit("select", id));
}
</script>

<template>
  <UPopover v-model:open="open" :content="{ align: 'start' }">
    <UButton
      color="primary"
      size="sm"
      icon="i-lucide-list-tree"
      class="shadow-lg ring-2 ring-(--ui-bg)"
      :label="t('common.content.outline.button')"
      :aria-label="t('common.content.outline.label')"
    />

    <template #content>
      <div
        class="max-h-[min(32rem,calc(var(--reka-popover-content-available-height,70dvh)-0.5rem))] w-[min(22rem,90vw)] overflow-y-auto p-1.5"
      >
        <ContentOutlineList :items="items" :active="active" @pick="pick" />
      </div>
    </template>
  </UPopover>
</template>
