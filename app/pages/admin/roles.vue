<script setup lang="ts">
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import {
  ALL_PERMISSION_KEYS,
  PERMISSION_DESCRIPTION_I18N_KEYS,
  PERMISSION_KEYS,
} from "~~/shared/constants/permissions";
import type { PermissionKey } from "~~/shared/constants/permissions";
import { roleLabelKey } from "~/components/shell/RoleBadge.vue";

/**
 * What each role may do: a matrix of permissions by role, saved together.
 * Opens with `role:manage_permissions` (Secretaría and Presidencia hold it).
 * The Administrator role has every permission and is not listed. Someone
 * who is not an Admin cannot change the role they hold, which would let
 * them give themselves any permission or lock themselves out; its column is
 * read-only, with the reason, and the server refuses it too
 * (PUT /api/admin/roles/[id]/permissions).
 */
definePageMeta({
  middleware: ["admin"],
  adminAccess: ["role:manage_permissions"],
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
const localePath = useLocalePath();
const { me, isAdmin, can } = useMe();

/** The users page has its own permission: link to it only if it opens. */
const canManageUsers = computed(() => can(PERMISSION_KEYS.USER_MANAGE_ROLES));

useHead({ title: () => t("admin.roles.title") });

const {
  data: rolesData,
  status: rolesStatus,
  error: rolesError,
  refresh: refreshRoles,
} = await useFetch<{ data: RoleRow[] }>("/api/admin/roles", {
  key: "admin-roles",
});

/**
 * Column order: the Mesa first (Secretaría, Presidencia, Moderador), then
 * members and guests; custom roles go last, by name.
 */
const ROLE_ORDER: readonly string[] = [
  SYSTEM_ROLES.SECRETARIA,
  SYSTEM_ROLES.PRESIDENCIA,
  SYSTEM_ROLES.MODERADOR,
  SYSTEM_ROLES.CEA,
  SYSTEM_ROLES.ASOCIADO,
  SYSTEM_ROLES.INVITADO,
];

function roleRank(name: string): number {
  const index = ROLE_ORDER.indexOf(name);
  return index === -1 ? ROLE_ORDER.length : index;
}

/** Admin bypasses every check, so its permissions are not editable. */
const editableRoles = computed(() =>
  (rolesData.value?.data ?? [])
    .filter((role) => role.name !== SYSTEM_ROLES.ADMIN)
    .sort(
      (a, b) =>
        roleRank(a.name) - roleRank(b.name) || a.name.localeCompare(b.name),
    ),
);

/**
 * Presidencia is created by the seed, not by a migration: on a database not
 * seeded since it was added, the role is missing until someone re-runs it.
 */
const presidenciaMissing = computed(
  () =>
    rolesData.value !== null &&
    rolesData.value !== undefined &&
    !rolesData.value.data.some(
      (role) => role.name === SYSTEM_ROLES.PRESIDENCIA,
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

/**
 * The editable role the signed-in user holds, which they cannot change;
 * null for an Admin, whose role is not listed.
 */
const ownRoleId = computed(() => {
  if (isAdmin.value) return null;
  const name = me.value?.role;
  return editableRoles.value.find((role) => role.name === name)?.id ?? null;
});

function ownRoleLocked(roleId: string): boolean {
  return roleId === ownRoleId.value;
}

function toggle(roleId: string, key: PermissionKey, value: boolean): void {
  if (ownRoleLocked(roleId)) return;
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
        <p
          v-if="ownRoleId"
          id="roles-own-role-locked"
          class="text-muted flex items-center gap-1.5 text-sm"
        >
          <UIcon
            name="i-lucide-lock"
            class="size-4 shrink-0"
            aria-hidden="true"
          />
          {{ t("admin.roles.ownAccessLocked") }}
        </p>
        <p
          v-if="canManageUsers"
          class="text-muted flex flex-wrap items-center gap-1.5 text-sm"
        >
          <UIcon
            name="i-lucide-user-plus"
            class="size-4 shrink-0"
            aria-hidden="true"
          />
          <span>{{ t("admin.roles.userPermissionsHint") }}</span>
          <ULink
            :to="localePath('/admin/usuarios')"
            class="text-primary font-medium hover:underline"
          >
            {{ t("admin.roles.toUsers") }}
          </ULink>
        </p>
      </div>

      <p class="sr-only" aria-live="polite" aria-atomic="true">
        {{ statusMessage }}
      </p>

      <UAlert
        v-if="presidenciaMissing"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :title="t('admin.roles.presidenciaMissingTitle')"
        :description="t('admin.roles.presidenciaMissing')"
      />

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
                <UIcon
                  v-if="ownRoleLocked(role.id)"
                  name="i-lucide-lock"
                  class="text-muted ms-1 size-3.5 align-middle"
                  aria-hidden="true"
                />
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
                    :disabled="
                      saving || !saved[role.id] || ownRoleLocked(role.id)
                    "
                    :aria-describedby="
                      ownRoleLocked(role.id)
                        ? 'roles-own-role-locked'
                        : undefined
                    "
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
