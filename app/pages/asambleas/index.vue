<script setup lang="ts">
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
} from "~~/shared/constants/security";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import {
  ASSEMBLY_STATUSES,
  type AssemblyStatus,
} from "~~/shared/constants/statuses";
import { ALL_ASSEMBLY_TYPES } from "~~/shared/constants/assemblyTypes";

const { t } = useI18n();
const toast = useToast();
const { hasPermission } = usePermissions();

useHead({ title: t("assembly.title") });

interface Assembly {
  id: string;
  number: number;
  type: string;
  status: AssemblyStatus;
  startDate: string;
  endDate: string;
  location: string;
  updatedAt: string;
}

interface AssembliesResponse {
  data: Assembly[];
  pagination: {
    page: number;
    pageSize: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
}

const page = ref(1);
const filterStatus = ref<AssemblyStatus | undefined>(undefined);

const {
  data: assembliesData,
  refresh,
  status: fetchStatus,
} = await useFetch<AssembliesResponse>("/api/assemblies", {
  query: computed(() => ({
    page: page.value,
    status: filterStatus.value,
  })),
});

const assemblies = computed(() => assembliesData.value?.data ?? []);
const pagination = computed(() => assembliesData.value?.pagination);

const canCreate = computed(() =>
  hasPermission(PERMISSION_KEYS.ASSEMBLY_CREATE),
);

const statusFilterOptions = [
  { label: t("assembly.filter.allStatuses"), value: undefined },
  {
    label: t("assembly.statuses.draft"),
    value: ASSEMBLY_STATUSES.DRAFT,
  },
  {
    label: t("assembly.statuses.provisional"),
    value: ASSEMBLY_STATUSES.PROVISIONAL,
  },
  {
    label: t("assembly.statuses.definitive"),
    value: ASSEMBLY_STATUSES.DEFINITIVE,
  },
];

const emptyForm = () => ({
  number: null as number | null,
  type: ALL_ASSEMBLY_TYPES[0] as string,
  startDate: "",
  endDate: "",
  location: "",
});

const modalOpen = ref(false);
const formData = ref(emptyForm());
const formLoading = ref(false);

const openCreateModal = () => {
  formData.value = emptyForm();
  modalOpen.value = true;
};

const submitForm = async () => {
  if (
    !formData.value.number ||
    !formData.value.startDate ||
    !formData.value.endDate ||
    !formData.value.location
  ) {
    toast.add({ title: t("errors.serverError"), color: "error" });
    return;
  }

  formLoading.value = true;
  try {
    const csrfToken = useCookie(CSRF_COOKIE_NAME).value;
    await $fetch("/api/assemblies", {
      method: "POST",
      body: {
        number: formData.value.number,
        type: formData.value.type,
        startDate: new Date(formData.value.startDate).toISOString(),
        endDate: new Date(formData.value.endDate).toISOString(),
        location: formData.value.location,
      },
      headers: csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : undefined,
    });
    toast.add({ title: t("assembly.created"), color: "success" });
    modalOpen.value = false;
    page.value = 1;
    await refresh();
  } catch (err: unknown) {
    const statusCode = (err as { statusCode?: number })?.statusCode;
    if (statusCode === 409) {
      toast.add({
        title: t("errors.conflict"),
        color: "error",
      });
    } else {
      toast.add({ title: t("errors.serverError"), color: "error" });
    }
  } finally {
    formLoading.value = false;
  }
};

const onFilterChange = (val: unknown) => {
  filterStatus.value = (val as { value?: AssemblyStatus } | undefined)?.value;
  page.value = 1;
};
</script>

<template>
  <UContainer class="py-8">
    <div class="flex flex-wrap items-center justify-between gap-4">
      <h1 class="text-2xl font-bold">{{ t("assembly.title") }}</h1>

      <div class="flex items-center gap-3">
        <USelectMenu
          :model-value="
            statusFilterOptions.find((o) => o.value === filterStatus)
          "
          :items="statusFilterOptions"
          class="w-48"
          :aria-label="t('assembly.filter.allStatuses')"
          @update:model-value="onFilterChange"
        />

        <UButton
          v-if="canCreate"
          icon="i-tabler-plus"
          color="primary"
          @click="openCreateModal"
        >
          {{ t("assembly.create") }}
        </UButton>
      </div>
    </div>

    <div v-if="fetchStatus === 'pending'" class="mt-8 text-center">
      <p class="text-muted">{{ t("common.loading") }}</p>
    </div>

    <div v-else-if="assemblies.length === 0" class="mt-16 text-center">
      <UIcon name="i-tabler-gavel" class="text-muted mx-auto size-12" />
      <h2 class="mt-4 text-lg font-semibold">
        {{ t("assembly.noAssemblies") }}
      </h2>
      <p class="text-muted mt-1 text-sm">
        {{ t("assembly.noAssembliesDescription") }}
      </p>
      <UButton
        v-if="canCreate"
        class="mt-4"
        icon="i-tabler-plus"
        color="primary"
        @click="openCreateModal"
      >
        {{ t("assembly.create") }}
      </UButton>
    </div>

    <div v-else class="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <AssemblyCard
        v-for="assembly in assemblies"
        :key="assembly.id"
        :assembly="assembly"
      />
    </div>

    <div
      v-if="assemblies.length > 0"
      class="mt-6 flex items-center justify-end gap-2"
    >
      <UButton
        variant="soft"
        color="neutral"
        :disabled="!pagination?.hasPreviousPage"
        @click="page--"
      >
        {{ t("common.previous") }}
      </UButton>
      <UButton
        variant="soft"
        color="neutral"
        :disabled="!pagination?.hasNextPage"
        @click="page++"
      >
        {{ t("common.next") }}
      </UButton>
    </div>

    <UModal v-model:open="modalOpen" :title="t('assembly.create')">
      <template #body>
        <AssemblyForm
          v-model="formData"
          :loading="formLoading"
          @submit="submitForm"
        >
          <template #actions>
            <UButton variant="ghost" color="neutral" @click="modalOpen = false">
              {{ t("common.cancel") }}
            </UButton>
          </template>
        </AssemblyForm>
      </template>
    </UModal>
  </UContainer>
</template>
