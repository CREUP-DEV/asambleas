<script setup lang="ts">
import type { AgendaTreeNode } from "~/utils/agendaTree";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
} from "~~/shared/constants/security";

const props = defineProps<{
  item: AgendaTreeNode;
  assemblyId: string;
  canManage: boolean;
  canDrag: boolean;
  isDefinitive: boolean;
  isSavingOrder: boolean;
}>();

const emit = defineEmits<{
  refresh: [];
}>();

const { t } = useI18n();
const localePath = useLocalePath();
const toast = useToast();

const expanded = ref(true);
const settingsOpen = ref(false);
const editMode = ref(false);
const addSubMode = ref(false);
const deleteModalOpen = ref(false);

const editFormData = ref({ title: props.item.title });
const subFormData = ref({ title: "" });
const editLoading = ref(false);
const subLoading = ref(false);
const deleteLoading = ref(false);

const canEditRoot = computed(
  () => props.canManage && !(props.isDefinitive && !props.item.parentId),
);

const saveEdit = async () => {
  if (!editFormData.value.title.trim()) return;
  editLoading.value = true;
  try {
    const csrfToken = useCookie(CSRF_COOKIE_NAME).value;
    await $fetch(
      `/api/assemblies/${props.assemblyId}/agenda-items/${props.item.id}`,
      {
        method: "PUT",
        body: {
          title: editFormData.value.title,
          updatedAt: new Date(props.item.updatedAt).toISOString(),
        },
        headers: csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : undefined,
      },
    );
    toast.add({ title: t("assembly.agenda.itemUpdated"), color: "success" });
    editMode.value = false;
    emit("refresh");
  } catch (err: unknown) {
    const code = (err as { statusCode?: number })?.statusCode;
    toast.add({
      title: code === 409 ? t("errors.conflict") : t("errors.serverError"),
      color: "error",
    });
  } finally {
    editLoading.value = false;
  }
};

const saveSubItem = async () => {
  if (!subFormData.value.title.trim()) return;
  subLoading.value = true;
  try {
    const csrfToken = useCookie(CSRF_COOKIE_NAME).value;
    await $fetch(`/api/assemblies/${props.assemblyId}/agenda-items`, {
      method: "POST",
      body: {
        parentId: props.item.id,
        title: subFormData.value.title,
        order: props.item.children.length,
      },
      headers: csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : undefined,
    });
    toast.add({ title: t("assembly.agenda.itemCreated"), color: "success" });
    subFormData.value = { title: "" };
    addSubMode.value = false;
    expanded.value = true;
    emit("refresh");
  } catch {
    toast.add({ title: t("errors.serverError"), color: "error" });
  } finally {
    subLoading.value = false;
  }
};

const deleteItem = async () => {
  deleteLoading.value = true;
  try {
    const csrfToken = useCookie(CSRF_COOKIE_NAME).value;
    await $fetch(
      `/api/assemblies/${props.assemblyId}/agenda-items/${props.item.id}`,
      {
        method: "DELETE",
        headers: csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : undefined,
      },
    );
    toast.add({ title: t("assembly.agenda.itemDeleted"), color: "success" });
    deleteModalOpen.value = false;
    emit("refresh");
  } catch {
    toast.add({ title: t("errors.serverError"), color: "error" });
  } finally {
    deleteLoading.value = false;
  }
};
</script>

<template>
  <li class="agenda-sortable-item select-none">
    <div
      class="group flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-elevated/60"
      :style="{ paddingLeft: `${item.depth * 20 + 8}px` }"
    >
      <UButton
        v-if="item.children.length > 0"
        variant="ghost"
        color="neutral"
        size="xs"
        :icon="expanded ? 'i-tabler-chevron-down' : 'i-tabler-chevron-right'"
        :aria-label="
          expanded
            ? t('assembly.agenda.collapseItem')
            : t('assembly.agenda.expandItem')
        "
        @click="expanded = !expanded"
      />
      <span v-else class="size-6 shrink-0" />

      <span class="text-muted w-8 shrink-0 text-right text-xs font-mono">
        {{ item.number }}
      </span>

      <template v-if="editMode">
        <AgendaItemForm
          v-model="editFormData"
          :loading="editLoading"
          class="flex-1"
          @submit="saveEdit"
          @cancel="editMode = false"
        />
      </template>
      <template v-else>
        <NuxtLink
          :to="localePath(`/asambleas/${assemblyId}/punto/${item.id}`)"
          class="flex-1 text-sm font-medium hover:underline"
          >{{ item.title }}</NuxtLink
        >

        <div
          v-if="canManage"
          class="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100"
        >
          <UButton
            v-if="canDrag"
            variant="ghost"
            color="neutral"
            size="xs"
            icon="i-tabler-grip-vertical"
            class="drag-handle cursor-grab active:cursor-grabbing"
            :aria-label="t('assembly.agenda.dragItem')"
            :disabled="isSavingOrder"
          />
          <UButton
            v-if="canEditRoot"
            variant="ghost"
            color="neutral"
            size="xs"
            icon="i-tabler-pencil"
            :aria-label="t('assembly.agenda.editItem')"
            @click="
              editMode = true;
              editFormData.title = item.title;
            "
          />
          <UButton
            variant="ghost"
            color="neutral"
            size="xs"
            icon="i-tabler-plus"
            :aria-label="t('assembly.agenda.addSubItem')"
            @click="
              addSubMode = !addSubMode;
              expanded = true;
            "
          />
          <UButton
            variant="ghost"
            color="neutral"
            size="xs"
            icon="i-tabler-settings"
            :aria-label="t('assembly.agenda.settings')"
            @click="settingsOpen = !settingsOpen"
          />
          <UButton
            v-if="canEditRoot"
            variant="ghost"
            color="error"
            size="xs"
            icon="i-tabler-trash"
            :aria-label="t('assembly.agenda.deleteItem')"
            @click="deleteModalOpen = true"
          />
        </div>
      </template>
    </div>

    <div v-if="settingsOpen" class="ml-10 mb-2 rounded-lg border">
      <AgendaItemSettings
        :item="item"
        :assembly-id="assemblyId"
        :can-manage="canManage"
        @updated="
          settingsOpen = false;
          $emit('refresh');
        "
      />
    </div>

    <div v-if="addSubMode" class="mt-1 ml-10 mb-2">
      <AgendaItemForm
        v-model="subFormData"
        :loading="subLoading"
        is-sub-item
        @submit="saveSubItem"
        @cancel="addSubMode = false"
      />
    </div>

    <AgendaTreeList
      v-if="expanded && item.children.length > 0"
      :items="item.children"
      :assembly-id="assemblyId"
      :can-manage="canManage"
      :is-definitive="isDefinitive"
      :parent-id="item.id"
      @refresh="$emit('refresh')"
    />

    <UModal
      v-model:open="deleteModalOpen"
      :title="t('assembly.agenda.deleteItemConfirm')"
    >
      <template #body>
        <p class="text-muted text-sm">
          {{ t("assembly.agenda.deleteItemDescription") }}
        </p>
        <div class="mt-4 flex justify-end gap-2">
          <UButton
            variant="ghost"
            color="neutral"
            @click="deleteModalOpen = false"
          >
            {{ t("common.cancel") }}
          </UButton>
          <UButton color="error" :loading="deleteLoading" @click="deleteItem">
            {{ t("common.delete") }}
          </UButton>
        </div>
      </template>
    </UModal>
  </li>
</template>
