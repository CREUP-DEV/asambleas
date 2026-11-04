<script setup lang="ts">
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type { AssemblyListDto, AssemblySummaryDto } from "~~/shared/types/api";
import { roleLabelKey } from "~/components/shell/RoleBadge.vue";
import {
  assemblyPath,
  projectionPath,
} from "~/components/shell/Navigation.vue";

const { t, locale } = useI18n();
const localePath = useLocalePath();
const { me, member, isAdmin, can } = useMe();

useHead({ title: () => t("home.title") });

// The list is sorted by start date, newest first, so every assembly still
// to come (and any in session) is on the first page.
const { data, status, error, refresh } = await useFetch<AssemblyListDto>(
  "/api/assemblies",
  { key: "home-assemblies", query: { page: 1 } },
);

// The shared clock: the greeting, the date and the upcoming list follow it.
const now = useAppNow();

const assemblies = computed(() => data.value?.items ?? []);

const inSession = computed(() =>
  assemblies.value.filter((item) => item.status === "in_session"),
);

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
    ),
);

const loading = computed(
  () => status.value === "pending" && assemblies.value.length === 0,
);

// Greeting --------------------------------------------------------------

const firstName = computed(() => {
  const name = me.value?.name?.trim() ?? "";
  return name.split(/\s+/)[0] ?? "";
});

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
  firstName.value
    ? t(greetingKey.value, { name: firstName.value })
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
      visible: isAdmin.value,
      label: t("home.admin.users"),
      icon: "i-lucide-users",
      to: localePath("/admin/usuarios"),
    },
    {
      key: "roles",
      visible: isAdmin.value,
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
      <UDashboardNavbar :title="t('home.title')" />
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
                :to="localePath(assemblyPath(assembly.slug))"
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
          <section
            aria-labelledby="home-upcoming-title"
            class="flex flex-col gap-3 lg:col-span-2"
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

            <ul
              v-if="loading"
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
                  <USkeleton class="h-6 w-28" />
                  <USkeleton class="h-5 w-20" />
                </div>
                <USkeleton class="h-4 w-48" />
                <USkeleton class="h-4 w-40" />
                <USkeleton class="h-4 w-32" />
              </li>
            </ul>

            <CommonEmptyState
              v-else-if="!error && upcoming.length === 0"
              icon="i-lucide-calendar-off"
              :title="t('home.upcoming.empty')"
              :description="t('home.upcoming.emptyDescription')"
              variant="outline"
            >
              <template #action>
                <UButton
                  :to="localePath('/asambleas')"
                  color="neutral"
                  variant="outline"
                >
                  {{ t("home.upcoming.all") }}
                </UButton>
              </template>
            </CommonEmptyState>

            <ul v-else-if="!error" class="grid gap-4 sm:grid-cols-2">
              <li v-for="assembly in upcoming" :key="assembly.id">
                <AssemblyCard :assembly="assembly" :heading-level="3" />
              </li>
            </ul>
          </section>

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
                  {{ t(`shell.memberKinds.${member.kind}`) }}
                </p>
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
