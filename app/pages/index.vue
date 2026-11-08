<script setup lang="ts">
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type {
  AssemblyListDto,
  AssemblySummaryDto,
  MeWorkDto,
} from "~~/shared/types/api";
import {
  homeWorkNews,
  homeWorkReviewPending,
  homeWorkTasks,
  homeWorkUpdates,
} from "~/components/home/-work";
import { roleLabelKey } from "~/components/shell/RoleBadge.vue";
import {
  assemblyPath,
  projectionPath,
} from "~/components/shell/Navigation.vue";

/**
 * Home: what the signed-in user has to do (GET /api/me/work: expected
 * documents, corrections, drafts, the transactionals over their amendments
 * waiting for their answer and, for main presenters, the amendments to
 * answer), what others decided about their work ("Novedades": a main
 * presenter's answer, a main author's answer to a transactional, the
 * Secretaría or the assembly), where their documents and amendments stand,
 * the Secretaría's pending review per assembly, a live-session banner that
 * leads to the live view and the upcoming assemblies. It leads with the
 * work and stays calm: few cards, one sentence per item. The admin
 * shortcuts open by permission, as the admin pages do.
 */

const { t, locale } = useI18n();
const localePath = useLocalePath();
const { me, member, can } = useMe();

useHead({ title: () => t("home.title") });

// The list is sorted by start date, newest first, so every assembly still
// to come (and any in session) is on the first page. Each request fails on
// its own: a missing work list never hides the assemblies, or the reverse.
const [assembliesFetch, workFetch] = await Promise.all([
  useFetch<AssemblyListDto>("/api/assemblies", {
    key: "home-assemblies",
    query: { page: 1 },
  }),
  useFetch<MeWorkDto>("/api/me/work", { key: "me-work" }),
]);
const { data, status, error, refresh } = assembliesFetch;
const {
  data: work,
  status: workStatus,
  error: workError,
  refresh: refreshWork,
} = workFetch;

// The shared clock: the greeting, the date, deadlines and the upcoming list
// follow it.
const now = useAppNow();

const assemblies = computed(() => data.value?.items ?? []);

const inSession = computed(() =>
  assemblies.value.filter((item) => item.status === "in_session"),
);

/** The next few assemblies; the full list is one click away. */
const UPCOMING_LIMIT = 4;

const upcoming = computed<AssemblySummaryDto[]>(() =>
  assemblies.value
    .filter(
      (item) =>
        item.status !== "in_session" &&
        item.status !== "closed" &&
        new Date(item.endDate).getTime() >= now.value,
    )
    .sort(
      (a, b) =>
        new Date(a.startDate).getTime() - new Date(b.startDate).getTime(),
    )
    .slice(0, UPCOMING_LIMIT),
);

const loading = computed(
  () => status.value === "pending" && assemblies.value.length === 0,
);

// Work ------------------------------------------------------------------

const tasks = computed(() =>
  work.value ? homeWorkTasks(work.value, now.value) : [],
);
const updates = computed(() => (work.value ? homeWorkUpdates(work.value) : []));
const news = computed(() => (work.value ? homeWorkNews(work.value) : []));
const review = computed(() =>
  work.value ? homeWorkReviewPending(work.value.review) : [],
);
const workLoading = computed(
  () => workStatus.value === "pending" && !work.value,
);
const nothingToDo = computed(
  () => tasks.value.length === 0 && review.value.length === 0,
);
// With an assembly in session, following it is the screen's main action:
// the work below keeps secondary buttons.
const workIsPrimary = computed(() => inSession.value.length === 0);

// Greeting --------------------------------------------------------------

// The whole name: many accounts belong to a body ("Vocalía de ..."), whose
// first word alone says nothing.
const displayName = computed(() => me.value?.name?.trim() ?? "");

const greetingKey = computed(() => {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      hourCycle: "h23",
      timeZone: APP_TIME_ZONE,
    }).format(new Date(now.value)),
  );
  if (hour >= 6 && hour < 14) return "home.greeting.morning";
  if (hour >= 14 && hour < 21) return "home.greeting.afternoon";
  return "home.greeting.evening";
});

const greeting = computed(() =>
  displayName.value
    ? t(greetingKey.value, { name: displayName.value })
    : t(`${greetingKey.value}Anonymous`),
);

const today = computed(() => formatDate(now.value, { locale: locale.value }));

const roleLabel = computed(() => {
  const role = me.value?.role ?? null;
  const key = roleLabelKey(role);
  return key ? t(key) : role;
});

// Admin shortcuts ---------------------------------------------------------

const adminLinks = computed(() =>
  [
    {
      key: "users",
      visible: can(PERMISSION_KEYS.USER_MANAGE_ROLES),
      label: t("home.admin.users"),
      icon: "i-lucide-users",
      to: localePath("/admin/usuarios"),
    },
    {
      key: "roles",
      visible: can(PERMISSION_KEYS.ROLE_MANAGE_PERMISSIONS),
      label: t("home.admin.roles"),
      icon: "i-lucide-shield-check",
      to: localePath("/admin/roles"),
    },
    {
      key: "members",
      visible: can(PERMISSION_KEYS.MEMBER_MANAGE),
      label: t("home.admin.members"),
      icon: "i-lucide-building-2",
      to: localePath("/admin/miembros"),
    },
  ].filter((link) => link.visible),
);
</script>

<template>
  <UDashboardPanel id="home">
    <template #header>
      <UDashboardNavbar :title="t('home.title')">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="mx-auto flex w-full max-w-6xl flex-col gap-6 lg:gap-8">
        <header>
          <h2 class="text-highlighted text-2xl font-bold sm:text-3xl">
            {{ greeting }}
          </h2>
          <p class="text-muted mt-1 text-sm first-letter:uppercase">
            {{ today }}
          </p>
        </header>

        <section
          v-if="inSession.length > 0"
          aria-labelledby="home-live-title"
          class="flex flex-col gap-3"
        >
          <h2
            id="home-live-title"
            class="text-highlighted flex items-center gap-2 text-lg font-semibold"
          >
            <span class="relative flex size-2.5" aria-hidden="true">
              <span
                class="bg-error absolute inline-flex size-full animate-ping rounded-full opacity-75 motion-reduce:animate-none"
              />
              <span
                class="bg-error relative inline-flex size-2.5 rounded-full"
              />
            </span>
            {{ t("home.live.title") }}
          </h2>

          <div
            v-for="assembly in inSession"
            :key="assembly.id"
            class="bg-success/5 ring-success/40 flex flex-col gap-4 rounded-lg p-4 ring sm:flex-row sm:items-center sm:justify-between sm:p-5"
          >
            <div class="min-w-0">
              <p class="text-highlighted text-xl font-semibold">
                {{ assembly.label }}
              </p>
              <p class="text-muted mt-0.5 text-sm">
                {{ assembly.location }}
              </p>
            </div>
            <div class="flex flex-wrap gap-2">
              <UButton
                :to="localePath(assemblyPath(assembly.slug, 'live'))"
                icon="i-lucide-radio"
                color="success"
              >
                {{ t("home.live.follow") }}
              </UButton>
              <UButton
                :to="localePath(projectionPath(assembly.slug))"
                target="_blank"
                icon="i-lucide-presentation"
                color="neutral"
                variant="outline"
                trailing-icon="i-lucide-external-link"
                :aria-label="t('home.live.projectionNewTab')"
              >
                {{ t("home.live.projection") }}
              </UButton>
            </div>
          </div>
        </section>

        <div class="grid gap-6 lg:grid-cols-3 lg:gap-8">
          <div class="flex min-w-0 flex-col gap-8 lg:col-span-2">
            <!-- What to do -->
            <section
              aria-labelledby="home-todo-title"
              class="flex flex-col gap-3"
            >
              <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2
                  id="home-todo-title"
                  class="text-highlighted text-lg font-semibold"
                >
                  {{ t("home.todo.title") }}
                </h2>
                <p
                  v-if="tasks.length > 0"
                  class="text-muted text-sm"
                  role="status"
                >
                  {{
                    t("home.todo.count", { count: tasks.length }, tasks.length)
                  }}
                </p>
              </div>

              <div
                v-if="workLoading"
                class="ring-default space-y-4 rounded-lg p-4 ring"
                role="status"
              >
                <span class="sr-only">{{ t("home.todo.loading") }}</span>
                <div v-for="n in 2" :key="n" class="flex gap-3">
                  <USkeleton
                    aria-hidden="true"
                    class="size-8 shrink-0 rounded-full"
                  />
                  <div class="flex-1 space-y-2">
                    <USkeleton aria-hidden="true" class="h-4 w-1/2" />
                    <USkeleton aria-hidden="true" class="h-4 w-3/4" />
                  </div>
                </div>
              </div>

              <UAlert
                v-else-if="workError && !work"
                color="error"
                variant="subtle"
                icon="i-lucide-circle-alert"
                :title="t('home.todo.loadFailed')"
                :actions="[
                  {
                    label: t('home.retry'),
                    color: 'error',
                    variant: 'outline',
                    onClick: () => refreshWork(),
                  },
                ]"
              />

              <template v-else>
                <ul
                  v-if="review.length > 0"
                  class="grid gap-4"
                  :class="review.length > 1 ? 'sm:grid-cols-2' : ''"
                >
                  <li v-for="(entry, index) in review" :key="entry.assembly.id">
                    <HomeReviewCard
                      :review="entry"
                      :heading-level="3"
                      :primary="workIsPrimary && index === 0"
                    />
                  </li>
                </ul>

                <UCard v-if="tasks.length > 0">
                  <HomeTaskList
                    :tasks="tasks"
                    :primary="workIsPrimary && review.length === 0"
                  />
                </UCard>

                <CommonEmptyState
                  v-if="nothingToDo"
                  icon="i-lucide-circle-check-big"
                  :title="t('home.todo.emptyTitle')"
                  :description="
                    member
                      ? t('home.todo.emptyDescription')
                      : t('home.todo.emptyNoMember')
                  "
                  variant="outline"
                />
              </template>
            </section>

            <!-- What others decided about the user's work -->
            <section
              v-if="news.length > 0"
              aria-labelledby="home-news-title"
              class="flex flex-col gap-3"
            >
              <h2
                id="home-news-title"
                class="text-highlighted text-lg font-semibold"
              >
                {{ t("home.news.title") }}
              </h2>
              <UCard>
                <HomeNewsList :news="news" />
              </UCard>
            </section>

            <!-- Where the rest stands -->
            <section
              v-if="updates.length > 0"
              aria-labelledby="home-mine-title"
              class="flex flex-col gap-3"
            >
              <h2
                id="home-mine-title"
                class="text-highlighted text-lg font-semibold"
              >
                {{ t("home.mine.title") }}
              </h2>
              <UCard>
                <HomeUpdateList :updates="updates" />
              </UCard>
            </section>

            <!-- Upcoming assemblies -->
            <section
              aria-labelledby="home-upcoming-title"
              class="flex flex-col gap-3"
            >
              <div class="flex items-center justify-between gap-3">
                <h2
                  id="home-upcoming-title"
                  class="text-highlighted text-lg font-semibold"
                >
                  {{ t("home.upcoming.title") }}
                </h2>
                <UButton
                  :to="localePath('/asambleas')"
                  color="neutral"
                  variant="link"
                  trailing-icon="i-lucide-arrow-right"
                >
                  {{ t("home.upcoming.all") }}
                </UButton>
              </div>

              <UAlert
                v-if="error"
                color="error"
                variant="subtle"
                icon="i-lucide-circle-alert"
                :title="t('home.loadFailed')"
                :actions="[
                  {
                    label: t('home.retry'),
                    color: 'error',
                    variant: 'outline',
                    onClick: () => refresh(),
                  },
                ]"
              />

              <ul
                v-else-if="loading"
                class="grid gap-4 sm:grid-cols-2"
                :aria-label="t('home.loading')"
                aria-busy="true"
              >
                <li
                  v-for="n in 2"
                  :key="n"
                  class="ring-default space-y-3 rounded-lg p-5 ring"
                >
                  <div class="flex justify-between gap-3">
                    <USkeleton aria-hidden="true" class="h-6 w-28" />
                    <USkeleton aria-hidden="true" class="h-5 w-20" />
                  </div>
                  <USkeleton aria-hidden="true" class="h-4 w-48" />
                  <USkeleton aria-hidden="true" class="h-4 w-40" />
                </li>
              </ul>

              <CommonEmptyState
                v-else-if="upcoming.length === 0"
                icon="i-lucide-calendar-off"
                :title="t('home.upcoming.empty')"
                :description="t('home.upcoming.emptyDescription')"
                variant="outline"
                size="sm"
              />

              <ul v-else class="grid gap-4 sm:grid-cols-2">
                <li v-for="assembly in upcoming" :key="assembly.id">
                  <AssemblyCard :assembly="assembly" :heading-level="3" />
                </li>
              </ul>
            </section>
          </div>

          <aside class="flex flex-col gap-4" :aria-label="t('home.aside')">
            <UCard>
              <template #header>
                <h2 class="text-highlighted font-semibold">
                  {{ t("home.member.title") }}
                </h2>
              </template>

              <div v-if="member" class="flex flex-col gap-3">
                <CommonMemberBadge :member="member" size="lg" show-name />
                <p class="text-muted text-sm">
                  {{ t("home.member.actingFor") }}
                </p>
              </div>
              <p v-else class="text-muted text-sm">
                {{ t("home.member.none") }}
              </p>

              <template v-if="roleLabel" #footer>
                <div class="flex items-center justify-between gap-2 text-sm">
                  <span class="text-muted">{{ t("home.member.role") }}</span>
                  <ShellRoleBadge :role="me?.role" />
                </div>
              </template>
            </UCard>

            <UCard v-if="adminLinks.length > 0">
              <template #header>
                <h2 class="text-highlighted font-semibold">
                  {{ t("home.admin.title") }}
                </h2>
              </template>
              <ul class="-my-1 flex flex-col">
                <li v-for="link in adminLinks" :key="link.key">
                  <UButton
                    :to="link.to"
                    :icon="link.icon"
                    color="neutral"
                    variant="ghost"
                    trailing-icon="i-lucide-chevron-right"
                    block
                    class="justify-start"
                    :ui="{ trailingIcon: 'ms-auto' }"
                  >
                    {{ link.label }}
                  </UButton>
                </li>
              </ul>
            </UCard>
          </aside>
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
