<script setup lang="ts">
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";

definePageMeta({
  middleware: ["admin"],
  adminAccess: ["admin", "member:manage"],
});

const { t } = useI18n();
const localePath = useLocalePath();
const { isAdmin, can } = useMe();

useHead({ title: () => t("admin.title") });

const sections = computed(() =>
  [
    {
      key: "users",
      visible: isAdmin.value,
      label: t("admin.users.title"),
      description: t("admin.users.description"),
      icon: "i-lucide-users",
      to: localePath("/admin/usuarios"),
    },
    {
      key: "roles",
      visible: isAdmin.value,
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
  ].filter((section) => section.visible),
);
</script>

<template>
  <UDashboardPanel id="admin-home">
    <template #header>
      <UDashboardNavbar :title="t('admin.title')" />
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
