<script setup lang="ts">
import { ALL_ASSEMBLY_TYPES } from "~~/shared/constants/assemblyTypes";
import type { AssemblyType } from "~~/shared/constants/assemblyTypes";
import { ASSEMBLY_STATUSES } from "~~/shared/constants/domain";
import type { AssemblyStatus } from "~~/shared/constants/domain";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type { AssemblyListDto } from "~~/shared/types/api";

type TypeFilter = AssemblyType | "all";
type StatusFilter = AssemblyStatus | "all";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const { can } = useMe();

useHead({ title: () => t("assemblies.title") });

const canCreate = computed(() => can(PERMISSION_KEYS.ASSEMBLY_CREATE));
const canSeeDrafts = computed(
  () =>
    can(PERMISSION_KEYS.ASSEMBLY_MANAGE) ||
    can(PERMISSION_KEYS.SESSION_MODERATE),
);

// Filters live in the URL so they survive reloads and can be shared.

function queryValue(key: string): string | undefined {
  const value = route.query[key];
  return typeof value === "string" ? value : undefined;
}

function isType(value: string | undefined): value is AssemblyType {
  return (ALL_ASSEMBLY_TYPES as readonly string[]).includes(value ?? "");
}

function isStatus(value: string | undefined): value is AssemblyStatus {
  return (ASSEMBLY_STATUSES as readonly string[]).includes(value ?? "");
}

function updateQuery(changes: Record<string, string | undefined>): void {
  const query = Object.fromEntries(
    Object.entries({ ...route.query, ...changes }).filter(
      ([, value]) => value !== undefined,
    ),
  );
  void router.replace({ query });
}

const typeFilter = computed<TypeFilter>({
  get: () => {
    const value = queryValue("type");
    return isType(value) ? value : "all";
  },
  set: (value) =>
    updateQuery({ type: value === "all" ? undefined : value, page: undefined }),
});

const statusFilter = computed<StatusFilter>({
  get: () => {
    const value = queryValue("status");
    return isStatus(value) ? value : "all";
  },
  set: (value) =>
    updateQuery({
      status: value === "all" ? undefined : value,
      page: undefined,
    }),
});

const page = computed<number>({
  get: () => {
    const value = Number(queryValue("page"));
    return Number.isInteger(value) && value > 1 ? value : 1;
  },
  set: (value) => updateQuery({ page: value > 1 ? String(value) : undefined }),
});

const hasFilters = computed(
  () => typeFilter.value !== "all" || statusFilter.value !== "all",
);

function clearFilters(): void {
  updateQuery({ type: undefined, status: undefined, page: undefined });
}

const typeItems = computed(() => [
  { label: t("assemblies.filters.allTypes"), value: "all" },
  ...ALL_ASSEMBLY_TYPES.map((type) => ({
    label: `${type} · ${t(`assemblies.types.${type}`)}`,
    value: type,
  })),
]);

const statusItems = computed(() => [
  { label: t("assemblies.filters.allStatuses"), value: "all" },
  ...ASSEMBLY_STATUSES.filter(
    (status) => status !== "draft" || canSeeDrafts.value,
  ).map((status) => ({
    label: t(`assemblies.statuses.${status}`),
    value: status,
  })),
]);

const { data, status, error, refresh } = await useFetch<AssemblyListDto>(
  "/api/assemblies",
  {
    key: "assemblies-list",
    query: computed(() => ({
      type: typeFilter.value === "all" ? undefined : typeFilter.value,
      status: statusFilter.value === "all" ? undefined : statusFilter.value,
      page: page.value,
    })),
  },
);

const items = computed(() => data.value?.items ?? []);
const total = computed(() => data.value?.total ?? 0);
const pageSize = computed(() => data.value?.pageSize ?? 20);
const loading = computed(() => status.value === "pending");

const summary = computed(() =>
  loading.value
    ? t("assemblies.loading")
    : t("assemblies.count", { count: total.value }, total.value),
);

// A page past the end (e.g. after a filter change elsewhere): go back.
watch(
  () => [total.value, page.value] as const,
  ([count, current]) => {
    if (
      !loading.value &&
      count > 0 &&
      items.value.length === 0 &&
      current > 1
    ) {
      page.value = Math.max(1, Math.ceil(count / pageSize.value));
    }
  },
);

const createOpen = ref(false);
</script>

<template>
  <UDashboardPanel id="assemblies">
    <template #header>
      <UDashboardNavbar :title="t('assemblies.title')">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <UButton
            v-if="canCreate"
            icon="i-lucide-plus"
            @click="createOpen = true"
          >
            <span class="hidden sm:inline">{{ t("assemblies.new") }}</span>
            <span class="sr-only sm:hidden">{{ t("assemblies.new") }}</span>
          </UButton>
        </template>
      </UDashboardNavbar>
      <ShellBreadcrumbs />

      <UDashboardToolbar>
        <template #left>
          <div class="flex flex-wrap items-center gap-2 py-2">
            <USelect
              v-model="typeFilter"
              :items="typeItems"
              :aria-label="t('assemblies.filters.type')"
              icon="i-lucide-tag"
              class="w-48 sm:w-64"
            />
            <USelect
              v-model="statusFilter"
              :items="statusItems"
              :aria-label="t('assemblies.filters.status')"
              icon="i-lucide-circle-dot"
              class="w-44"
            />
            <UButton
              v-if="hasFilters"
              color="neutral"
              variant="ghost"
              icon="i-lucide-filter-x"
              @click="clearFilters"
            >
              {{ t("assemblies.filters.clear") }}
            </UButton>
          </div>
        </template>
        <template #right>
          <p
            class="text-muted hidden text-sm whitespace-nowrap md:block"
            aria-live="polite"
          >
            {{ summary }}
          </p>
        </template>
      </UDashboardToolbar>
    </template>

    <template #body>
      <p class="sr-only md:hidden" aria-live="polite">{{ summary }}</p>

      <UAlert
        v-if="error"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :title="t('assemblies.loadFailed')"
        :actions="[
          {
            label: t('assemblies.retry'),
            color: 'error',
            variant: 'outline',
            onClick: () => refresh(),
          },
        ]"
      />

      <ul
        v-else-if="loading && items.length === 0"
        class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
        :aria-label="t('assemblies.loading')"
        aria-busy="true"
      >
        <li
          v-for="n in 6"
          :key="n"
          class="ring-default space-y-3 rounded-lg p-5 ring"
        >
          <div class="flex justify-between gap-3">
            <USkeleton aria-hidden="true" class="h-6 w-28" />
            <USkeleton aria-hidden="true" class="h-5 w-20" />
          </div>
          <USkeleton aria-hidden="true" class="h-4 w-48" />
          <USkeleton aria-hidden="true" class="h-4 w-40" />
          <USkeleton aria-hidden="true" class="h-4 w-32" />
        </li>
      </ul>

      <CommonEmptyState
        v-else-if="items.length === 0"
        :icon="hasFilters ? 'i-lucide-filter-x' : 'i-lucide-landmark'"
        :title="hasFilters ? t('assemblies.noMatches') : t('assemblies.empty')"
        :description="
          hasFilters
            ? t('assemblies.noMatchesDescription')
            : canCreate
              ? t('assemblies.emptyDescriptionManager')
              : t('assemblies.emptyDescription')
        "
      >
        <template v-if="hasFilters || canCreate" #action>
          <UButton
            v-if="hasFilters"
            color="neutral"
            variant="outline"
            icon="i-lucide-filter-x"
            @click="clearFilters"
          >
            {{ t("assemblies.filters.clear") }}
          </UButton>
          <UButton v-else icon="i-lucide-plus" @click="createOpen = true">
            {{ t("assemblies.new") }}
          </UButton>
        </template>
      </CommonEmptyState>

      <template v-else>
        <ul
          class="grid gap-4 transition-opacity sm:grid-cols-2 xl:grid-cols-3"
          :class="{ 'opacity-60': loading }"
          :aria-busy="loading"
          :aria-label="t('assemblies.listLabel')"
        >
          <li v-for="assembly in items" :key="assembly.id">
            <AssemblyCard :assembly="assembly" :heading-level="2" />
          </li>
        </ul>

        <div v-if="total > pageSize" class="flex justify-center pt-2">
          <UPagination
            v-model:page="page"
            :total="total"
            :items-per-page="pageSize"
            :sibling-count="1"
            show-edges
          />
        </div>
      </template>

      <AssemblyCreateModal v-if="canCreate" v-model:open="createOpen" />
    </template>
  </UDashboardPanel>
</template>
