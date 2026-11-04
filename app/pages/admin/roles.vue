<script setup lang="ts">
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import {
  ALL_PERMISSION_KEYS,
  PERMISSION_DESCRIPTION_I18N_KEYS,
} from "~~/shared/constants/permissions";
import type { PermissionKey } from "~~/shared/constants/permissions";
import { roleLabelKey } from "~/components/shell/RoleBadge.vue";

definePageMeta({
  middleware: ["admin"],
  adminAccess: ["admin"],
});

interface RoleRow {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
}

const { t, te } = useI18n();
const toast = useToast();
const api = useApi();

useHead({ title: () => t("admin.roles.title") });

const {
  data: rolesData,
  status: rolesStatus,
  error: rolesError,
  refresh: refreshRoles,
} = await useFetch<{ data: RoleRow[] }>("/api/admin/roles", {
  key: "admin-roles",
});

/** Admin bypasses every check, so its permissions are not editable. */
const editableRoles = computed(() =>
  (rolesData.value?.data ?? []).filter(
    (role) => role.name !== SYSTEM_ROLES.ADMIN,
  ),
);

const saved = ref<Record<string, PermissionKey[]>>({});
const draft = ref<Record<string, PermissionKey[]>>({});
const loadingPermissions = ref(false);
const permissionsFailed = ref(false);
const saving = ref(false);
const statusMessage = ref("");

async function loadPermissions(): Promise<void> {
  const roles = editableRoles.value.filter((role) => !saved.value[role.id]);
  if (roles.length === 0) return;
  loadingPermissions.value = true;
  permissionsFailed.value = false;
  try {
    const results = await Promise.all(
      roles.map((role) =>
        api.get<{ permissions: PermissionKey[] }>(
          `/api/admin/roles/${role.id}/permissions`,
        ),
      ),
    );
    roles.forEach((role, index) => {
      const keys = results[index]?.permissions ?? [];
      saved.value[role.id] = [...keys];
      draft.value[role.id] = [...keys];
    });
  } catch (error) {
    permissionsFailed.value = true;
    api.notifyError(error, "admin.loadFailed");
  } finally {
    loadingPermissions.value = false;
  }
}

onMounted(loadPermissions);
watch(editableRoles, loadPermissions);

function changed(roleId: string): boolean {
  const before = saved.value[roleId] ?? [];
  const after = draft.value[roleId] ?? [];
  return (
    before.length !== after.length || after.some((key) => !before.includes(key))
  );
}

const changedRoles = computed(() =>
  editableRoles.value.filter((role) => changed(role.id)),
);
const hasChanges = computed(() => changedRoles.value.length > 0);

function isGranted(roleId: string, key: PermissionKey): boolean {
  return (draft.value[roleId] ?? []).includes(key);
}

function toggle(roleId: string, key: PermissionKey, value: boolean): void {
  const current = draft.value[roleId] ?? [];
  draft.value[roleId] = value
    ? [...new Set([...current, key])]
    : current.filter((existing) => existing !== key);
}

function discard(): void {
  for (const role of editableRoles.value) {
    draft.value[role.id] = [...(saved.value[role.id] ?? [])];
  }
  statusMessage.value = t("admin.roles.discarded");
}

async function save(): Promise<void> {
  const roles = changedRoles.value;
  if (roles.length === 0) return;
  saving.value = true;
  try {
    await Promise.all(
      roles.map((role) =>
        api.send(`/api/admin/roles/${role.id}/permissions`, {
          method: "PUT",
          body: { permissionKeys: draft.value[role.id] ?? [] },
        }),
      ),
    );
    for (const role of roles) {
      saved.value[role.id] = [...(draft.value[role.id] ?? [])];
    }
    statusMessage.value = t("admin.roles.permissionsUpdated");
    toast.add({
      title: t("admin.roles.permissionsUpdated"),
      color: "success",
      icon: "i-lucide-check",
    });
  } catch (error) {
    api.notifyError(error, "admin.roles.saveFailed");
    // Some roles may have been saved: reload what the server holds.
    saved.value = {};
    await loadPermissions();
  } finally {
    saving.value = false;
  }
}

function roleName(name: string): string {
  const key = roleLabelKey(name);
  return key ? t(key) : name;
}

function permissionLabel(key: PermissionKey): string {
  const i18nKey = PERMISSION_DESCRIPTION_I18N_KEYS[key];
  return i18nKey && te(i18nKey) ? t(i18nKey) : key;
}

onBeforeRouteLeave(() => {
  if (!hasChanges.value || saving.value) return true;
  return window.confirm(t("admin.roles.leaveConfirm"));
});
</script>

<template>
  <UDashboardPanel id="admin-roles">
    <template #header>
      <UDashboardNavbar :title="t('admin.roles.title')">
        <template #right>
          <UButton
            color="neutral"
            variant="ghost"
            :disabled="!hasChanges || saving"
            class="hidden sm:inline-flex"
            @click="discard"
          >
            {{ t("admin.roles.discard") }}
          </UButton>
          <UButton
            icon="i-lucide-save"
            :disabled="!hasChanges"
            :loading="saving"
            @click="save"
          >
            {{ t("admin.save") }}
          </UButton>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="space-y-1">
        <p class="text-muted text-sm">{{ t("admin.roles.description") }}</p>
        <p class="text-muted flex items-center gap-1.5 text-sm">
          <UIcon name="i-lucide-lock" class="size-4" aria-hidden="true" />
          {{ t("admin.roles.adminPermissionsLocked") }}
        </p>
      </div>

      <p class="sr-only" aria-live="polite" aria-atomic="true">
        {{ statusMessage }}
      </p>

      <UAlert
        v-if="hasChanges"
        color="warning"
        variant="subtle"
        icon="i-lucide-pencil"
        :title="
          t(
            'admin.roles.unsaved',
            { count: changedRoles.length },
            changedRoles.length,
          )
        "
        :actions="[
          {
            label: t('admin.roles.discard'),
            color: 'neutral',
            variant: 'outline',
            onClick: discard,
          },
        ]"
      />

      <UAlert
        v-if="rolesError || permissionsFailed"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :title="t('admin.loadFailed')"
        :actions="[
          {
            label: t('admin.retry'),
            color: 'error',
            variant: 'outline',
            onClick: async () => {
              await refreshRoles();
              await loadPermissions();
            },
          },
        ]"
      />

      <div
        v-else-if="
          rolesStatus === 'pending' ||
          (loadingPermissions && Object.keys(saved).length === 0)
        "
        class="space-y-2"
        :aria-busy="true"
        :aria-label="t('admin.loading')"
      >
        <USkeleton v-for="n in 8" :key="n" class="h-10 w-full" />
      </div>

      <CommonEmptyState
        v-else-if="editableRoles.length === 0"
        icon="i-lucide-shield"
        :title="t('admin.roles.noRoles')"
      />

      <div
        v-else
        class="border-default overflow-x-auto rounded-lg border"
        role="region"
        :aria-label="t('admin.roles.matrix')"
        tabindex="0"
      >
        <table class="w-full min-w-[36rem] text-sm">
          <caption class="sr-only">
            {{
              t("admin.roles.matrix")
            }}
          </caption>
          <thead class="bg-elevated/50">
            <tr class="border-default border-b">
              <th scope="col" class="p-3 text-start font-semibold">
                {{ t("admin.roles.permission") }}
              </th>
              <th
                v-for="role in editableRoles"
                :key="role.id"
                scope="col"
                class="p-3 text-center font-semibold whitespace-nowrap"
              >
                {{ roleName(role.name) }}
                <span
                  v-if="changed(role.id)"
                  class="bg-warning ms-1 inline-block size-1.5 rounded-full align-middle"
                  :title="t('admin.roles.roleChanged')"
                />
                <span v-if="changed(role.id)" class="sr-only">
                  {{ t("admin.roles.roleChanged") }}
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="key in ALL_PERMISSION_KEYS"
              :key="key"
              class="border-default hover:bg-elevated/40 border-b last:border-b-0"
            >
              <th scope="row" class="p-3 text-start font-normal">
                <span class="text-highlighted block">
                  {{ permissionLabel(key) }}
                </span>
                <code class="text-dimmed text-xs">{{ key }}</code>
              </th>
              <td
                v-for="role in editableRoles"
                :key="role.id"
                class="p-3 text-center align-middle"
              >
                <div class="flex justify-center">
                  <UCheckbox
                    :model-value="isGranted(role.id, key)"
                    :disabled="saving || !saved[role.id]"
                    :aria-label="
                      t('admin.roles.grant', {
                        permission: permissionLabel(key),
                        role: roleName(role.name),
                      })
                    "
                    @update:model-value="
                      (value: boolean | 'indeterminate') =>
                        toggle(role.id, key, value === true)
                    "
                  />
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </UDashboardPanel>
</template>
