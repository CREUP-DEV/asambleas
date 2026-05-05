<script setup lang="ts">
import type { FlatAgendaItem } from "~/utils/agendaTree";
import { buildAgendaTree } from "~/utils/agendaTree";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
} from "~~/shared/constants/security";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { ASSEMBLY_STATUSES } from "~~/shared/constants/statuses";

const props = defineProps<{
  assemblyId: string;
  assemblySlug?: string;
  assemblyStatus: string;
}>();

const { t } = useI18n();
const toast = useToast();
const { hasPermission } = usePermissions();

const canManage = computed(() =>
  hasPermission(PERMISSION_KEYS.ASSEMBLY_MANAGE),
);
const isDefinitive = computed(
  () => props.assemblyStatus === ASSEMBLY_STATUSES.DEFINITIVE,
);

const {
  data: rawItems,
  refresh,
  status: fetchStatus,
} = await useFetch<FlatAgendaItem[]>(
  `/api/assemblies/${props.assemblyId}/agenda-items`,
);

const tree = computed(() => buildAgendaTree(rawItems.value ?? []));

const addRootMode = ref(false);
const rootFormData = ref({ title: "" });
const rootLoading = ref(false);

const addRootItem = async () => {
  if (!rootFormData.value.title.trim()) return;
  rootLoading.value = true;
  try {
    const csrfToken = useCookie(CSRF_COOKIE_NAME).value;
    await $fetch(`/api/assemblies/${props.assemblyId}/agenda-items`, {
      method: "POST",
      body: {
        title: rootFormData.value.title,
        order: tree.value.length,
      },
      headers: csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : undefined,
    });
    toast.add({ title: t("assembly.agenda.itemCreated"), color: "success" });
    rootFormData.value = { title: "" };
    addRootMode.value = false;
    await refresh();
  } catch {
    toast.add({ title: t("errors.serverError"), color: "error" });
  } finally {
    rootLoading.value = false;
  }
};
</script>

<template>
  <div>
    <div class="mb-3 flex items-center justify-between gap-2">
      <div v-if="isDefinitive && canManage" class="text-muted text-xs">
        {{ t("assembly.agenda.rootLockedDefinitive") }}
      </div>
      <div class="ml-auto flex gap-2">
        <UButton
          v-if="canManage && !isDefinitive"
          variant="soft"
          color="neutral"
          size="sm"
          icon="i-tabler-plus"
          @click="addRootMode = !addRootMode"
        >
          {{ t("assembly.agenda.addItem") }}
        </UButton>
      </div>
    </div>

    <div v-if="addRootMode" class="mb-3">
      <AgendaItemForm
        v-model="rootFormData"
        :loading="rootLoading"
        @submit="addRootItem"
        @cancel="addRootMode = false"
      />
    </div>

    <div
      v-if="fetchStatus === 'pending'"
      class="text-muted py-4 text-center text-sm"
    >
      {{ t("common.loading") }}
    </div>

    <div
      v-else-if="tree.length === 0"
      class="text-muted py-6 text-center text-sm"
    >
      {{ t("assembly.agenda.noItems") }}
    </div>

    <AgendaTreeList
      v-else
      :items="tree"
      :assembly-id="assemblyId"
      :assembly-slug="assemblySlug ?? assemblyId"
      :can-manage="canManage"
      :is-definitive="isDefinitive"
      :parent-id="null"
      @refresh="refresh()"
    />
  </div>
</template>
