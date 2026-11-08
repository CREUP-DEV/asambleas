<script setup lang="ts">
import type { TabsItem } from "@nuxt/ui";
import type { RouteLocationRaw } from "vue-router";
import type {
  ActivityItemDto,
  ActivityPageDto,
  AdminImpersonationDto,
  AdminImpersonationPageDto,
} from "~~/shared/types/api";
import {
  adminActivityApiQuery,
  adminActivityFilterCount,
  adminActivityRouteQuery,
  adminImpersonationApiQuery,
  parseAdminActivityQuery,
  type AdminActivityFilters,
} from "~/composables/activity/-filters";
import { activityItemKey } from "~/composables/activity/-present";

/**
 * The platform's whole activity log, for Admins only (GET
 * /api/admin/activity and GET /api/admin/impersonations, both refused to
 * anyone whose real role is not Admin, and while impersonating). Two views:
 * "Registro", every recorded change with who did it, as whom, on what,
 * from where (origin and IP); and "Suplantaciones", every time an Admin
 * acted as an account. Filters live in the URL, so a view can be shared and
 * the users page links here with `?user=<id>`.
 */
definePageMeta({
  middleware: ["admin"],
});

const { t } = useI18n();
const route = useRoute();
const router = useRouter();

useHead({ title: () => t("activity.admin.title") });

const filters = computed<AdminActivityFilters>({
  get: () => parseAdminActivityQuery(route.query),
  set: (next) => {
    void router.replace({ query: adminActivityRouteQuery(next) });
  },
});

/** The current URL with these filters changed (undefined removes one). */
function filterLink(
  changes: Record<string, string | undefined>,
): RouteLocationRaw {
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries({
    ...adminActivityRouteQuery(filters.value),
    ...changes,
  })) {
    if (value !== undefined) query[key] = value;
  }
  return { path: route.path, query };
}

const viewItems = computed<TabsItem[]>(() => [
  {
    label: t("activity.admin.views.log"),
    value: "log",
    icon: "i-lucide-scroll-text",
  },
  {
    label: t("activity.admin.views.impersonations"),
    value: "impersonations",
    icon: "i-lucide-venetian-mask",
  },
]);

const view = computed<string>({
  get: () => filters.value.view,
  set: (value) => {
    filters.value = {
      ...filters.value,
      view: value === "impersonations" ? "impersonations" : "log",
    };
  },
});

const isLog = computed(() => filters.value.view === "log");

const log = await useActivityPages<ActivityItemDto, ActivityPageDto>({
  key: "admin-activity",
  url: "/api/admin/activity",
  query: computed(() => adminActivityApiQuery(filters.value)),
  keyOf: activityItemKey,
  enabled: isLog,
});

const impersonations = await useActivityPages<
  AdminImpersonationDto,
  AdminImpersonationPageDto
>({
  key: "admin-impersonations",
  url: "/api/admin/impersonations",
  query: computed(() => adminImpersonationApiQuery(filters.value)),
  keyOf: (item) => item.id,
  enabled: computed(() => !isLog.value),
});

const { users, status: usersStatus } = useActivityUserDirectory();
const { members, memberName } = useActivityMembers();
const { assemblies } = useActivityAssemblies();

const current = computed(() => (isLog.value ? log : impersonations));
const hasFilters = computed(() =>
  isLog.value
    ? adminActivityFilterCount(filters.value) > 0
    : filters.value.user !== null || filters.value.state !== "all",
);

/** The selected account's name, for the heading of a filtered view. */
const selectedUser = computed(() => {
  const id = filters.value.user;
  if (!id) return null;
  return users.value?.find((user) => user.id === id) ?? null;
});

function clearFilters(): void {
  filters.value = {
    ...filters.value,
    user: null,
    member: null,
    assembly: null,
    category: [],
    source: [],
    impersonated: false,
    impersonation: null,
    from: null,
    to: null,
    state: "all",
  };
}

const sectionTitleId = useId();
</script>

<template>
  <UDashboardPanel id="admin-activity">
    <template #header>
      <UDashboardNavbar :title="t('activity.admin.title')">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
      <UDashboardToolbar>
        <template #left>
          <UTabs
            v-model="view"
            :items="viewItems"
            :content="false"
            variant="link"
            :aria-label="t('activity.admin.views.label')"
          />
        </template>
      </UDashboardToolbar>
    </template>

    <template #body>
      <div class="flex flex-col gap-4">
        <p class="text-muted text-sm">
          {{
            isLog
              ? t("activity.admin.description")
              : t("activity.admin.impersonations.description")
          }}
        </p>

        <section :aria-labelledby="sectionTitleId" class="flex flex-col gap-4">
          <h2
            :id="sectionTitleId"
            class="text-highlighted text-base font-semibold"
          >
            {{
              selectedUser
                ? t("activity.admin.headingFor", {
                    view: isLog
                      ? t("activity.admin.views.log")
                      : t("activity.admin.views.impersonations"),
                    user: selectedUser.name,
                  })
                : isLog
                  ? t("activity.admin.views.log")
                  : t("activity.admin.views.impersonations")
            }}
          </h2>

          <ActivityAdminFilters
            v-model="filters"
            :users="users ?? []"
            :users-loading="usersStatus === 'pending'"
            :members="members ?? []"
            :assemblies="assemblies ?? []"
          />

          <UAlert
            v-if="current.error.value && !current.loading.value"
            color="error"
            variant="subtle"
            icon="i-lucide-circle-alert"
            :title="t('activity.list.error')"
            :description="t('activity.list.errorDescription')"
            :actions="[
              {
                label: t('activity.list.retry'),
                color: 'neutral',
                variant: 'outline',
                onClick: () => current.refresh(),
              },
            ]"
          />

          <template v-else>
            <ActivityAdminLog
              v-if="isLog"
              :items="log.items.value"
              :loading="log.status.value === 'pending'"
              :filter-link="filterLink"
              :member-name="memberName"
            >
              <template #empty>
                <CommonEmptyState
                  :icon="
                    hasFilters ? 'i-lucide-filter-x' : 'i-lucide-scroll-text'
                  "
                  :title="
                    hasFilters
                      ? t('activity.empty.filtered')
                      : t('activity.admin.empty')
                  "
                  :description="
                    hasFilters
                      ? t('activity.empty.filteredDescription')
                      : t('activity.admin.emptyDescription')
                  "
                >
                  <template v-if="hasFilters" #action>
                    <UButton
                      color="neutral"
                      variant="outline"
                      icon="i-lucide-filter-x"
                      @click="clearFilters"
                    >
                      {{ t("activity.filters.clear") }}
                    </UButton>
                  </template>
                </CommonEmptyState>
              </template>
            </ActivityAdminLog>

            <ActivityAdminImpersonations
              v-else
              :items="impersonations.items.value"
              :loading="impersonations.status.value === 'pending'"
              :filter-link="filterLink"
            >
              <template #empty>
                <CommonEmptyState
                  icon="i-lucide-venetian-mask"
                  :title="
                    hasFilters
                      ? t('activity.empty.filtered')
                      : t('activity.admin.impersonations.empty')
                  "
                  :description="
                    hasFilters
                      ? t('activity.empty.filteredDescription')
                      : t('activity.admin.impersonations.emptyDescription')
                  "
                >
                  <template v-if="hasFilters" #action>
                    <UButton
                      color="neutral"
                      variant="outline"
                      icon="i-lucide-filter-x"
                      @click="clearFilters"
                    >
                      {{ t("activity.filters.clear") }}
                    </UButton>
                  </template>
                </CommonEmptyState>
              </template>
            </ActivityAdminImpersonations>

            <ActivityLoadMore
              :has-more="current.hasMore.value"
              :loading="current.loadingMore.value"
              :announcement="current.announcement.value"
              :count="current.items.value.length"
              @load="current.loadMore"
            />
          </template>
        </section>
      </div>
    </template>
  </UDashboardPanel>
</template>
