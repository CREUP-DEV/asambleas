<script setup lang="ts">
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
} from "~~/shared/constants/security";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import {
  ALL_PERMISSION_KEYS,
  PERMISSION_DESCRIPTION_I18N_KEYS,
} from "~~/shared/constants/permissions";
import type { PermissionKey } from "~~/shared/constants/permissions";

const { t } = useI18n();

definePageMeta({
  layout: "admin",
});

useHead({
  title: t("admin.roles.title"),
});

interface RoleRow {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
}

interface PermissionRow {
  id: string;
  key: string;
  description: string | null;
}

const toast = useToast();

const { data: rolesData } = await useFetch<{
  data: RoleRow[];
}>("/api/admin/roles");

const { data: permissionsData } = await useFetch<{ data: PermissionRow[] }>(
  "/api/admin/permissions",
);

const allRoles = computed(() => rolesData.value?.data ?? []);
const _allPermissions = computed(() => permissionsData.value?.data ?? []);
const editableRoles = computed(() =>
  allRoles.value.filter((r) => r.name !== SYSTEM_ROLES.ADMIN),
);

const rolePermissionsMap = ref<Record<string, string[]>>({});
const loadingRoleId = ref<string | null>(null);

const loadRolePermissions = async (roleId: string) => {
  if (rolePermissionsMap.value[roleId]) return;
  const data = await $fetch<{
    permissions: string[];
  }>(`/api/admin/roles/${roleId}/permissions`);
  rolePermissionsMap.value[roleId] = data.permissions;
};

onMounted(async () => {
  await Promise.all(
    editableRoles.value.map((role) => loadRolePermissions(role.id)),
  );
});

const togglePermission = async (role: RoleRow, permissionKey: string) => {
  loadingRoleId.value = role.id;

  const current = rolePermissionsMap.value[role.id] ?? [];
  const hasIt = current.includes(permissionKey);
  const updated = hasIt
    ? current.filter((k) => k !== permissionKey)
    : [...current, permissionKey];

  try {
    const csrfToken = useCookie(CSRF_COOKIE_NAME).value;
    await $fetch(`/api/admin/roles/${role.id}/permissions`, {
      method: "PUT",
      body: { permissionKeys: updated },
      headers: csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : undefined,
    });
    rolePermissionsMap.value[role.id] = updated;
    toast.add({
      title: t("admin.roles.permissionsUpdated"),
      color: "success",
    });
  } catch {
    toast.add({
      title: t("errors.serverError"),
      color: "error",
    });
  } finally {
    loadingRoleId.value = null;
  }
};

const getPermissionLabel = (key: string) => {
  const i18nKey = PERMISSION_DESCRIPTION_I18N_KEYS[key as PermissionKey];
  return i18nKey ? t(i18nKey) : key;
};
</script>

<template>
  <div>
    <h1 class="text-2xl font-bold">
      {{ t("admin.roles.title") }} - {{ t("admin.roles.permissions") }}
    </h1>

    <p class="text-muted mt-1 text-sm">
      {{ t("admin.roles.adminPermissionsLocked") }}
    </p>

    <div class="mt-6 overflow-x-auto">
      <table class="w-full table-fixed text-sm">
        <thead>
          <tr class="border-default border-b">
            <th class="w-[44%] p-3 text-left font-semibold">
              {{ t("admin.roles.permissions") }}
            </th>
            <th
              v-for="role in editableRoles"
              :key="role.id"
              class="p-3 text-center font-semibold"
            >
              {{ role.name }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="pKey in ALL_PERMISSION_KEYS"
            :key="pKey"
            class="border-default border-b"
          >
            <td class="p-3">
              {{ getPermissionLabel(pKey) }}
            </td>
            <td
              v-for="role in editableRoles"
              :key="role.id"
              class="p-3 align-middle"
            >
              <div class="flex justify-center">
                <UCheckbox
                  :model-value="
                    (rolePermissionsMap[role.id] ?? []).includes(pKey)
                  "
                  :disabled="loadingRoleId === role.id"
                  @update:model-value="togglePermission(role, pKey)"
                />
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
