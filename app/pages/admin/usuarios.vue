<script setup lang="ts">
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
} from "~~/shared/constants/security";

const { t } = useI18n();

definePageMeta({
  layout: "admin",
});

useHead({
  title: t("admin.users.title"),
});

interface UserRow {
  id: string;
  name: string;
  email: string;
  image: string | null;
  roleId: string | null;
  externalRole: string | null;
  externalInitials: string | null;
  university: string | null;
  lastRoleSyncAt: string | null;
  createdAt: string;
  role: { id: string; name: string } | null;
}

interface RoleOption {
  id: string;
  name: string;
}

const toast = useToast();
const {
  data: usersData,
  refresh: refreshUsers,
  status: usersStatus,
} = await useFetch<{ data: UserRow[] }>("/api/admin/users");

const { data: rolesData } = await useFetch<{ data: RoleOption[] }>(
  "/api/admin/roles",
);

const users = computed(() => usersData.value?.data ?? []);
const roles = computed(() => rolesData.value?.data ?? []);
const roleOptions = computed(() =>
  roles.value.map((r) => ({ label: r.name, value: r.id })),
);

const changingRoleUserId = ref<string | null>(null);

const getRoleOption = (roleId: string | null) => {
  return roleOptions.value.find((role) => role.value === roleId);
};

const changeUserRole = async (userId: string, roleId: string) => {
  changingRoleUserId.value = userId;
  try {
    const csrfToken = useCookie(CSRF_COOKIE_NAME).value;
    await $fetch(`/api/admin/users/${userId}/role`, {
      method: "PUT",
      body: { roleId },
      headers: csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : undefined,
    });
    toast.add({
      title: t("admin.users.roleChanged"),
      color: "success",
    });
    await refreshUsers();
  } catch {
    toast.add({
      title: t("errors.serverError"),
      color: "error",
    });
  } finally {
    changingRoleUserId.value = null;
  }
};

const handleRoleSelection = (userId: string, value: unknown) => {
  const roleId =
    typeof value === "string" ? value : (value as { value?: string })?.value;

  if (!roleId) {
    return;
  }

  void changeUserRole(userId, roleId);
};

const _columns = [
  { key: "name", label: t("common.actions") },
  { key: "email", label: t("admin.users.email") },
  { key: "role", label: t("admin.users.role") },
  { key: "university", label: t("admin.users.university") },
  { key: "createdAt", label: t("admin.users.registeredAt") },
];
</script>

<template>
  <div>
    <h1 class="text-2xl font-bold">{{ t("admin.users.title") }}</h1>

    <div v-if="usersStatus === 'pending'" class="mt-6 text-center">
      <p class="text-muted">{{ t("common.loading") }}</p>
    </div>

    <div v-else-if="users.length === 0" class="mt-6 text-center">
      <p class="text-muted">{{ t("admin.users.noUsers") }}</p>
    </div>

    <UTable v-else :data="users" class="mt-6">
      <template #name-cell="{ row }">
        <div class="flex items-center gap-3">
          <img
            v-if="row.original.image"
            :src="row.original.image"
            :alt="row.original.name"
            class="size-8 rounded-full"
          />
          <div
            v-else
            class="bg-muted text-muted-foreground flex size-8 items-center justify-center rounded-full text-xs font-semibold"
          >
            {{
              row.original.externalInitials ||
              row.original.name?.[0]?.toUpperCase() ||
              "?"
            }}
          </div>
          <div>
            <p class="font-medium">{{ row.original.name }}</p>
            <p class="text-muted text-xs">{{ row.original.email }}</p>
          </div>
        </div>
      </template>

      <template #role-cell="{ row }">
        <USelectMenu
          :model-value="getRoleOption(row.original.roleId)"
          :items="roleOptions"
          :loading="changingRoleUserId === row.original.id"
          class="w-40"
          @update:model-value="
            (val: unknown) => handleRoleSelection(row.original.id, val)
          "
        />
      </template>

      <template #university-cell="{ row }">
        <span class="text-sm">{{ row.original.university || "—" }}</span>
      </template>

      <template #createdAt-cell="{ row }">
        <span class="text-muted text-sm">
          {{
            row.original.createdAt
              ? new Date(row.original.createdAt).toLocaleDateString()
              : "—"
          }}
        </span>
      </template>
    </UTable>
  </div>
</template>
