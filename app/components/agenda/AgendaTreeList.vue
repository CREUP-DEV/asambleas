<script setup lang="ts">
import type Sortable from "sortablejs";
import type { AgendaTreeNode } from "~/utils/agendaTree";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
} from "~~/shared/constants/security";

const props = defineProps<{
  items: AgendaTreeNode[];
  assemblyId: string;
  canManage: boolean;
  isDefinitive: boolean;
  parentId: string | null;
}>();

const emit = defineEmits<{
  refresh: [];
}>();

const { t } = useI18n();
const toast = useToast();
const listRef = ref<HTMLElement | null>(null);
const localItems = ref<AgendaTreeNode[]>([]);
const isSavingOrder = ref(false);
let sortableInstance: Sortable | null = null;

const canDrag = computed(
  () => props.canManage && !(props.isDefinitive && props.parentId === null),
);

watch(
  () => props.items,
  (items) => {
    localItems.value = [...items];
  },
  { immediate: true },
);

const persistOrder = async (movedItemId: string) => {
  isSavingOrder.value = true;
  try {
    const csrfToken = useCookie(CSRF_COOKIE_NAME).value;
    await $fetch(
      `/api/assemblies/${props.assemblyId}/agenda-items/${movedItemId}/reorder`,
      {
        method: "PUT",
        body: {
          items: localItems.value.map((item, order) => ({
            id: item.id,
            order,
            parentId: props.parentId,
          })),
        },
        headers: csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : undefined,
      },
    );
    toast.add({ title: t("assembly.agenda.reordered"), color: "success" });
    emit("refresh");
  } catch {
    localItems.value = [...props.items];
    toast.add({ title: t("errors.serverError"), color: "error" });
  } finally {
    isSavingOrder.value = false;
  }
};

const initializeSortable = async (el: HTMLElement | null) => {
  sortableInstance?.destroy();
  sortableInstance = null;

  if (!el || !canDrag.value || !import.meta.client) return;

  const { default: SortableJs } = await import("sortablejs");
  if (!listRef.value) return;

  sortableInstance = SortableJs.create(listRef.value, {
    animation: 180,
    easing: "cubic-bezier(0.16, 1, 0.3, 1)",
    handle: ".drag-handle",
    draggable: ".agenda-sortable-item",
    ghostClass: "opacity-50",
    chosenClass: "ring-2 ring-primary/30",
    dragClass: "shadow-lg",
    onEnd: async (event) => {
      if (event.oldIndex === undefined || event.newIndex === undefined) return;
      if (event.oldIndex === event.newIndex) return;

      const movedItem = localItems.value.splice(event.oldIndex, 1)[0];
      if (!movedItem) return;

      localItems.value.splice(event.newIndex, 0, movedItem);
      await persistOrder(movedItem.id);
    },
  });
};

watch(listRef, initializeSortable, { immediate: true });
watch(canDrag, () => initializeSortable(listRef.value));

onUnmounted(() => {
  sortableInstance?.destroy();
});
</script>

<template>
  <ul ref="listRef" class="space-y-0.5">
    <AgendaTreeItem
      v-for="item in localItems"
      :key="item.id"
      :item="item"
      :assembly-id="assemblyId"
      :can-manage="canManage"
      :can-drag="canDrag"
      :is-definitive="isDefinitive"
      :is-saving-order="isSavingOrder"
      @refresh="$emit('refresh')"
    />
  </ul>
</template>
