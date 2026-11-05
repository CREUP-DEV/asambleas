<script setup lang="ts">
import type { TabsItem } from "@nuxt/ui";
import type { ActivityItemDto, MeActivityPageDto } from "~~/shared/types/api";
import type { MeActivityTab } from "~~/shared/constants/activity";
import {
  ME_ACTIVITY_TAB_CATEGORIES,
  meActivityApiQuery,
  meActivityHasFilters,
  meActivityRouteQuery,
  meActivityTabHasAssemblies,
  parseMeActivityQuery,
  type MeActivityFilters,
} from "~/composables/activity/-filters";
import { activityItemKey } from "~/composables/activity/-present";

/**
 * "Mi actividad" (GET /api/me/activity), from the user menu. Four tabs:
 * what the account did, what was done to it (role, permissions, member
 * link, an Admin acting as it), its accesses (sign-ins with device and IP)
 * and, when it acts for a member, what other accounts did for that member.
 * Filters (assembly, kind, days) and the tab live in the URL. A notice on
 * top says when an Admin acted as the account in the last 30 days, and
 * everything they did is marked in the lists. Only the account and Admins
 * see this record; the server re-checks what the viewer may still see.
 */
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const { me, member } = useMe();

useHead({ title: () => t("activity.me.title") });

const filters = computed<MeActivityFilters>({
  get: () => parseMeActivityQuery(route.query, { hasMember: !!member.value }),
  set: (next) => {
    void router.replace({ query: meActivityRouteQuery(next) });
  },
});

const tabs: MeActivityTab[] = ["by", "to", "access", "member"];

const TAB_ICONS: Record<MeActivityTab, string> = {
  by: "i-lucide-history",
  to: "i-lucide-user-cog",
  access: "i-lucide-log-in",
  member: "i-lucide-building-2",
};

const tabItems = computed<TabsItem[]>(() =>
  tabs
    .filter((tab) => tab !== "member" || member.value)
    .map((tab) => ({
      label:
        tab === "member" && member.value
          ? t("activity.tabs.member", { member: member.value.acronym })
          : t(`activity.tabs.${tab}`),
      value: tab,
      icon: TAB_ICONS[tab],
    })),
);

/** Switching tabs keeps the dates and drops filters the tab does not take. */
const tab = computed<string>({
  get: () => filters.value.tab,
  set: (value) => {
    const next = tabs.find((item) => item === value) ?? "by";
    const category = filters.value.category;
    filters.value = {
      ...filters.value,
      tab: next,
      assembly: meActivityTabHasAssemblies(next)
        ? filters.value.assembly
        : null,
      category:
        category && ME_ACTIVITY_TAB_CATEGORIES[next].includes(category)
          ? category
          : null,
    };
  },
});

const apiQuery = computed(() => meActivityApiQuery(filters.value));

const {
  page,
  items,
  error,
  refresh,
  loading,
  refreshing,
  hasMore,
  loadingMore,
  announcement,
  loadMore,
} = await useActivityPages<ActivityItemDto, MeActivityPageDto>({
  key: "me-activity",
  url: "/api/me/activity",
  query: apiQuery,
  keyOf: activityItemKey,
});

const { assemblies, status: assembliesStatus } = useActivityAssemblies();
const { memberName } = useActivityMembers();

const recentImpersonations = computed(
  () => page.value?.recentImpersonations ?? [],
);
const hasFilters = computed(() => meActivityHasFilters(filters.value));

function clearFilters(): void {
  filters.value = {
    ...filters.value,
    assembly: null,
    category: null,
    from: null,
    to: null,
  };
}

const emptyTitle = computed(() =>
  hasFilters.value
    ? t("activity.empty.filtered")
    : t(`activity.empty.${filters.value.tab}.title`, {
        member: member.value?.acronym ?? "",
      }),
);
const emptyDescription = computed(() =>
  hasFilters.value
    ? t("activity.empty.filteredDescription")
    : t(`activity.empty.${filters.value.tab}.description`, {
        member: member.value?.acronym ?? "",
      }),
);

const panelTitleId = useId();
</script>

<template>
  <UDashboardPanel id="my-activity">
    <template #header>
      <UDashboardNavbar :title="t('activity.me.title')" />
    </template>

    <template #body>
      <div class="mx-auto flex w-full max-w-4xl flex-col gap-5">
        <p class="text-muted text-sm">
          {{ t("activity.me.description") }}
          {{ t("activity.me.privacy") }}
        </p>

        <ActivityImpersonationNotice
          v-if="recentImpersonations.length > 0"
          :impersonations="recentImpersonations"
          :on-access-tab="filters.tab === 'access'"
          @show-access="tab = 'access'"
        />

        <UTabs
          v-model="tab"
          :items="tabItems"
          :content="false"
          class="w-full"
          :ui="{ list: 'overflow-x-auto', trigger: 'shrink-0' }"
          :aria-label="t('activity.tabs.label')"
        />

        <section :aria-labelledby="panelTitleId" class="flex flex-col gap-4">
          <h2 :id="panelTitleId" class="sr-only">
            {{ tabItems.find((item) => item.value === filters.tab)?.label }}
          </h2>
          <p class="text-muted -mt-1 text-sm">
            {{ t(`activity.tabs.${filters.tab}Description`) }}
          </p>

          <ActivityMeFilters
            v-model="filters"
            :assemblies="assemblies ?? []"
            :assemblies-loading="assembliesStatus === 'pending'"
          />

          <div v-if="loading" class="flex flex-col gap-4" role="status">
            <span class="sr-only">{{ t("activity.list.loading") }}</span>
            <div v-for="i in 4" :key="i" class="flex gap-3" aria-hidden="true">
              <USkeleton class="size-8 shrink-0 rounded-full" />
              <div class="flex flex-1 flex-col gap-2">
                <USkeleton class="h-3 w-24" />
                <USkeleton class="h-4 w-3/4" />
                <USkeleton class="h-3 w-1/2" />
              </div>
            </div>
          </div>

          <UAlert
            v-else-if="error"
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
                onClick: () => refresh(),
              },
            ]"
          />

          <!-- A page can come back empty but unfinished ("member": others'
               acts on what this account cannot see are left out), so the
               empty state waits until nothing is left to load. -->
          <CommonEmptyState
            v-else-if="items.length === 0 && !hasMore"
            :icon="hasFilters ? 'i-lucide-filter-x' : TAB_ICONS[filters.tab]"
            :title="emptyTitle"
            :description="emptyDescription"
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

          <div v-else class="flex flex-col gap-4" :aria-busy="refreshing">
            <p v-if="items.length === 0" class="text-muted text-sm">
              {{ t("activity.list.emptyButMore") }}
            </p>
            <ActivityTimeline
              v-else
              :items="items"
              :self-id="me?.id ?? null"
              :show-actor="filters.tab === 'to' || filters.tab === 'member'"
              :show-access="filters.tab === 'access'"
              :member-name="memberName"
              :class="refreshing ? 'opacity-60' : ''"
            />
            <ActivityLoadMore
              :has-more="hasMore"
              :loading="loadingMore"
              :announcement="announcement"
              :count="items.length"
              @load="loadMore"
            />
          </div>
        </section>
      </div>
    </template>
  </UDashboardPanel>
</template>
