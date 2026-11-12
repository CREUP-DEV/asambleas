<script setup lang="ts">
import { CALENDAR_RULES_PERMISSION } from "~~/shared/constants/calendarRules";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";

/**
 * Administration home: one card per section the user may open. Each one
 * opens by permission (users, roles, members, calendar rules, statistics); an Admin
 * sees them all.
 */
definePageMeta({
  middleware: ["admin"],
  adminAccess: [
    "user:manage_roles",
    "role:manage_permissions",
    "member:manage",
    // CALENDAR_RULES_PERMISSION (page meta must be a literal).
    "assembly:manage",
    "stats:view",
  ],
});

const { t } = useI18n();
const localePath = useLocalePath();
const { can } = useMe();

useHead({ title: () => t("admin.title") });

const sections = computed(() =>
  [
    {
      key: "users",
      visible: can(PERMISSION_KEYS.USER_MANAGE_ROLES),
      label: t("admin.users.title"),
      description: t("admin.users.description"),
      icon: "i-lucide-users",
      to: localePath("/admin/usuarios"),
    },
    {
      key: "roles",
      visible: can(PERMISSION_KEYS.ROLE_MANAGE_PERMISSIONS),
      label: t("admin.roles.title"),
      description: t("admin.roles.description"),
      icon: "i-lucide-shield-check",
      to: localePath("/admin/roles"),
    },
    {
      key: "members",
      visible: can(PERMISSION_KEYS.MEMBER_MANAGE),
      label: t("admin.members.title"),
      description: t("admin.members.description"),
      icon: "i-lucide-building-2",
      to: localePath("/admin/miembros"),
    },
    {
      key: "calendarRules",
      visible: can(CALENDAR_RULES_PERMISSION),
      label: t("admin.calendarRules.title"),
      description: t("admin.calendarRules.description"),
      icon: "i-lucide-calendar-cog",
      to: localePath("/admin/calendario"),
    },
    {
      key: "stats",
      visible: can(PERMISSION_KEYS.STATS_VIEW),
      label: t("admin.stats.title"),
      description: t("admin.stats.cardDescription"),
      icon: "i-lucide-chart-column",
      to: localePath("/admin/estadisticas"),
    },
  ].filter((section) => section.visible),
);
</script>

<template>
  <UDashboardPanel id="admin-home">
    <template #header>
      <UDashboardNavbar :title="t('admin.title')">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
      <ShellBreadcrumbs />
    </template>

    <template #body>
      <div class="mx-auto w-full max-w-5xl">
        <p class="text-muted text-sm">{{ t("admin.intro") }}</p>

        <ul
          class="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
          :aria-label="t('admin.sections')"
        >
          <li v-for="section in sections" :key="section.key">
            <UPageCard
              :title="section.label"
              :description="section.description"
              :icon="section.icon"
              :to="section.to"
              variant="outline"
              class="h-full"
              :ui="{ leadingIcon: 'text-primary' }"
            />
          </li>
        </ul>
      </div>
    </template>
  </UDashboardPanel>
</template>
