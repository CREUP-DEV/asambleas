<script setup lang="ts">
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
} from "~~/shared/constants/security";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import {
  ASSEMBLY_STATUSES,
  ASSEMBLY_STATUS_TRANSITIONS,
  type AssemblyStatus,
} from "~~/shared/constants/statuses";

const { t, locale } = useI18n();
const route = useRoute();
const router = useRouter();
const localePath = useLocalePath();
const toast = useToast();
const { hasPermission } = usePermissions();

const id = route.params.id as string;

interface Assembly {
  id: string;
  number: number;
  type: string;
  status: AssemblyStatus;
  startDate: string;
  endDate: string;
  location: string;
  updatedAt: string;
  createdAt: string;
}

const { data: assembly, refresh } = await useFetch<Assembly>(
  `/api/assemblies/${id}`,
);

if (!assembly.value) {
  throw createError({ statusCode: 404, statusMessage: "Not Found" });
}

useHead({
  title: computed(
    () =>
      `${t("assembly.numberShort")} ${assembly.value?.number} — ${assembly.value ? t(`assembly.types.${assembly.value.type}`) : ""}`,
  ),
});

const canManage = computed(() =>
  hasPermission(PERMISSION_KEYS.ASSEMBLY_MANAGE),
);

const dateFormatter = computed(
  () =>
    new Intl.DateTimeFormat(locale.value, {
      dateStyle: "long",
      timeStyle: "short",
    }),
);

const formatDate = (d: string | Date) =>
  dateFormatter.value.format(new Date(d));

const validNextStatuses = computed(() => {
  if (!assembly.value) return [];
  return ASSEMBLY_STATUS_TRANSITIONS[assembly.value.status] ?? [];
});

const statusActionLabel = (status: AssemblyStatus): string => {
  const labels: Record<AssemblyStatus, string> = {
    [ASSEMBLY_STATUSES.DRAFT]: t("assembly.revertToDraft"),
    [ASSEMBLY_STATUSES.PROVISIONAL]:
      assembly.value?.status === ASSEMBLY_STATUSES.DRAFT
        ? t("assembly.promoteToProvisional")
        : t("assembly.revertToProvisional"),
    [ASSEMBLY_STATUSES.DEFINITIVE]: t("assembly.promoteToDefinitive"),
  };
  return labels[status];
};

const statusLoading = ref(false);

const changeStatus = async (newStatus: AssemblyStatus) => {
  if (!assembly.value) return;
  statusLoading.value = true;
  try {
    const csrfToken = useCookie(CSRF_COOKIE_NAME).value;
    await $fetch(`/api/assemblies/${id}/status`, {
      method: "PUT",
      body: {
        status: newStatus,
        updatedAt: assembly.value.updatedAt,
      },
      headers: csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : undefined,
    });
    toast.add({
      title: t("assembly.statusChanged", {
        status: t(`assembly.statuses.${newStatus}`),
      }),
      color: "success",
    });
    await refresh();
  } catch (err: unknown) {
    const statusCode = (err as { statusCode?: number })?.statusCode;
    if (statusCode === 409) {
      toast.add({ title: t("errors.conflict"), color: "error" });
    } else {
      toast.add({ title: t("errors.serverError"), color: "error" });
    }
  } finally {
    statusLoading.value = false;
  }
};

const editModalOpen = ref(false);
const editFormData = ref({
  number: null as number | null,
  type: "",
  startDate: "",
  endDate: "",
  location: "",
});
const editLoading = ref(false);

const toLocalDatetimeString = (d: string | Date) => {
  const date = new Date(d);
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60 * 1000);
  return local.toISOString().slice(0, 16);
};

const openEditModal = () => {
  if (!assembly.value) return;
  editFormData.value = {
    number: assembly.value.number,
    type: assembly.value.type,
    startDate: toLocalDatetimeString(assembly.value.startDate),
    endDate: toLocalDatetimeString(assembly.value.endDate),
    location: assembly.value.location,
  };
  editModalOpen.value = true;
};

const submitEdit = async () => {
  if (!assembly.value) return;
  editLoading.value = true;
  try {
    const csrfToken = useCookie(CSRF_COOKIE_NAME).value;
    await $fetch(`/api/assemblies/${id}`, {
      method: "PUT",
      body: {
        number: editFormData.value.number,
        type: editFormData.value.type,
        startDate: new Date(editFormData.value.startDate).toISOString(),
        endDate: new Date(editFormData.value.endDate).toISOString(),
        location: editFormData.value.location,
        updatedAt: assembly.value.updatedAt,
      },
      headers: csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : undefined,
    });
    toast.add({ title: t("assembly.updated"), color: "success" });
    editModalOpen.value = false;
    await refresh();
  } catch (err: unknown) {
    const statusCode = (err as { statusCode?: number })?.statusCode;
    if (statusCode === 409) {
      toast.add({ title: t("errors.conflict"), color: "error" });
    } else {
      toast.add({ title: t("errors.serverError"), color: "error" });
    }
  } finally {
    editLoading.value = false;
  }
};

const deleteModalOpen = ref(false);
const deleteLoading = ref(false);

const deleteAssembly = async () => {
  if (!assembly.value) return;
  deleteLoading.value = true;
  try {
    const csrfToken = useCookie(CSRF_COOKIE_NAME).value;
    await $fetch(`/api/assemblies/${id}`, {
      method: "DELETE",
      headers: csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : undefined,
    });
    toast.add({ title: t("assembly.deleted"), color: "success" });
    await router.push(localePath("/asambleas"));
  } catch (err: unknown) {
    const statusCode = (err as { statusCode?: number })?.statusCode;
    if (statusCode === 409) {
      toast.add({ title: t("assembly.onlyDraftDelete"), color: "error" });
    } else {
      toast.add({ title: t("errors.serverError"), color: "error" });
    }
    deleteLoading.value = false;
    deleteModalOpen.value = false;
  }
};

const isDraft = computed(
  () => assembly.value?.status === ASSEMBLY_STATUSES.DRAFT,
);
</script>

<template>
  <UContainer class="py-8">
    <div class="mb-6 flex items-center gap-3">
      <UButton
        :to="localePath('/asambleas')"
        variant="ghost"
        color="neutral"
        icon="i-tabler-arrow-left"
        size="sm"
      >
        {{ t("common.back") }}
      </UButton>
    </div>

    <div v-if="assembly" class="space-y-6">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p class="text-muted text-sm font-medium uppercase tracking-wide">
            {{ t(`assembly.types.${assembly.type}`) }}
          </p>
          <h1 class="mt-1 text-3xl font-bold">
            {{ t("assembly.numberShort") }} {{ assembly.number }}
          </h1>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <AssemblyStatusBadge :status="assembly.status" />

          <template v-if="canManage">
            <UButton
              v-for="nextStatus in validNextStatuses"
              :key="nextStatus"
              variant="soft"
              :color="
                nextStatus === ASSEMBLY_STATUSES.DEFINITIVE
                  ? 'success'
                  : nextStatus === ASSEMBLY_STATUSES.PROVISIONAL
                    ? 'warning'
                    : 'neutral'
              "
              size="sm"
              :loading="statusLoading"
              @click="changeStatus(nextStatus as AssemblyStatus)"
            >
              {{ statusActionLabel(nextStatus as AssemblyStatus) }}
            </UButton>

            <UButton
              variant="soft"
              color="neutral"
              icon="i-tabler-pencil"
              size="sm"
              @click="openEditModal"
            >
              {{ t("common.edit") }}
            </UButton>

            <UButton
              v-if="isDraft"
              variant="soft"
              color="error"
              icon="i-tabler-trash"
              size="sm"
              @click="deleteModalOpen = true"
            >
              {{ t("common.delete") }}
            </UButton>
          </template>
        </div>
      </div>

      <UCard>
        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <p class="text-muted text-xs font-medium uppercase tracking-wide">
              {{ t("assembly.startDate") }}
            </p>
            <p class="mt-1 font-medium">{{ formatDate(assembly.startDate) }}</p>
          </div>
          <div>
            <p class="text-muted text-xs font-medium uppercase tracking-wide">
              {{ t("assembly.endDate") }}
            </p>
            <p class="mt-1 font-medium">{{ formatDate(assembly.endDate) }}</p>
          </div>
          <div class="sm:col-span-2">
            <p class="text-muted text-xs font-medium uppercase tracking-wide">
              {{ t("assembly.location") }}
            </p>
            <p class="mt-1 font-medium">{{ assembly.location }}</p>
          </div>
        </div>
      </UCard>

      <div>
        <h2 class="mb-4 text-xl font-semibold">
          {{ t("assembly.agenda.title") }}
        </h2>
        <AgendaTree
          :assembly-id="assembly.id"
          :assembly-status="assembly.status"
        />
      </div>
    </div>

    <UModal v-model:open="editModalOpen" :title="t('assembly.edit')">
      <template #body>
        <AssemblyForm
          v-model="editFormData"
          :loading="editLoading"
          @submit="submitEdit"
        >
          <template #actions>
            <UButton
              variant="ghost"
              color="neutral"
              @click="editModalOpen = false"
            >
              {{ t("common.cancel") }}
            </UButton>
          </template>
        </AssemblyForm>
      </template>
    </UModal>

    <UModal v-model:open="deleteModalOpen" :title="t('assembly.deleteConfirm')">
      <template #body>
        <p class="text-muted text-sm">
          {{ t("assembly.deleteConfirmDescription") }}
        </p>
        <div class="mt-4 flex justify-end gap-2">
          <UButton
            variant="ghost"
            color="neutral"
            @click="deleteModalOpen = false"
          >
            {{ t("common.cancel") }}
          </UButton>
          <UButton
            color="error"
            :loading="deleteLoading"
            @click="deleteAssembly"
          >
            {{ t("common.delete") }}
          </UButton>
        </div>
      </template>
    </UModal>
  </UContainer>
</template>
