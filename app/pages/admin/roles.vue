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

const savedPermissionsMap = ref<Record<string, string[]>>({});
const draftPermissionsMap = ref<Record<string, string[]>>({});
const isSaving = ref(false);

const loadRolePermissions = async (roleId: string) => {
  if (savedPermissionsMap.value[roleId]) return;
  const data = await $fetch<{
    permissions: string[];
  }>(`/api/admin/roles/${roleId}/permissions`);
  savedPermissionsMap.value[roleId] = data.permissions;
  draftPermissionsMap.value[roleId] = [...data.permissions];
};

onMounted(async () => {
  await Promise.all(
    editableRoles.value.map((role) => loadRolePermissions(role.id)),
  );
});

const hasChanges = computed(() =>
  editableRoles.value.some((role) => {
    const saved = savedPermissionsMap.value[role.id] ?? [];
    const draft = draftPermissionsMap.value[role.id] ?? [];
    if (saved.length !== draft.length) return true;
    return draft.some((k) => !saved.includes(k));
  }),
);

const togglePermission = (role: RoleRow, permissionKey: string) => {
  const current = draftPermissionsMap.value[role.id] ?? [];
  const hasIt = current.includes(permissionKey);
  draftPermissionsMap.value[role.id] = hasIt
    ? current.filter((k) => k !== permissionKey)
    : [...current, permissionKey];
};

const saveChanges = async () => {
  isSaving.value = true;
  try {
    const csrfToken = useCookie(CSRF_COOKIE_NAME).value;
    const changedRoles = editableRoles.value.filter((role) => {
      const saved = savedPermissionsMap.value[role.id] ?? [];
      const draft = draftPermissionsMap.value[role.id] ?? [];
      return (
        saved.length !== draft.length || draft.some((k) => !saved.includes(k))
      );
    });

    await Promise.all(
      changedRoles.map((role) =>
        $fetch(`/api/admin/roles/${role.id}/permissions`, {
          method: "PUT",
          body: { permissionKeys: draftPermissionsMap.value[role.id] },
          headers: csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : undefined,
        }),
      ),
    );

    for (const role of changedRoles) {
      savedPermissionsMap.value[role.id] = [
        ...(draftPermissionsMap.value[role.id] ?? []),
      ];
    }

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
    isSaving.value = false;
  }
};

const discardChanges = () => {
  for (const role of editableRoles.value) {
    draftPermissionsMap.value[role.id] = [
      ...(savedPermissionsMap.value[role.id] ?? []),
    ];
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
                    (draftPermissionsMap[role.id] ?? []).includes(pKey)
                  "
                  :disabled="isSaving"
                  @update:model-value="togglePermission(role, pKey)"
                />
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="mt-4 flex justify-end gap-2">
      <UButton
        variant="ghost"
        color="neutral"
        :disabled="!hasChanges || isSaving"
        @click="discardChanges"
      >
        {{ t("common.discard") }}
      </UButton>
      <UButton
        color="primary"
        :disabled="!hasChanges"
        :loading="isSaving"
        @click="saveChanges"
      >
        {{ t("common.save") }}
      </UButton>
    </div>
  </div>
</template>
