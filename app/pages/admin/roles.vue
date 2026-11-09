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
 * who is not an Admin cannot take away from the role they hold the
 * permissions to manage users and roles, which would lock them (and
 * everyone with that role) out of this section: those two checkboxes of
 * their column are disabled, with the reason, and the server refuses it
 * too (PUT /api/admin/roles/[id]/permissions, adminGrantViolation
 * `own_role`). Other changes to their own role are allowed; taking a
 * permission away from it is warned about first, since they lose it too.
 * Nor can a non-Admin give or take a permission they do not hold
 * (`not_held`): that whole row is locked, with the reason.
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
const { me, isAdmin, can, refresh: refreshMe } = useMe();

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
  SYSTEM_ROLES.SECTORIAL,
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
 * The editable role the signed-in user holds; null for an Admin, whose
 * role is not listed and who may change any role.
 */
const ownRoleId = computed(() => {
  if (isAdmin.value) return null;
  const name = me.value?.role;
  return editableRoles.value.find((role) => role.name === name)?.id ?? null;
});

/** The permissions that open the administration of users and roles. */
const ADMIN_ACCESS_KEYS: readonly PermissionKey[] = [
  PERMISSION_KEYS.USER_MANAGE_ROLES,
  PERMISSION_KEYS.ROLE_MANAGE_PERMISSIONS,
];

/**
 * Secretaría and Presidencia hold every permission, and only an Admin
 * changes them, so neither can strip the other.
 */
function leadershipLocked(roleId: string): boolean {
  if (isAdmin.value) return false;
  const name = editableRoles.value.find((role) => role.id === roleId)?.name;
  return name === SYSTEM_ROLES.SECRETARIA || name === SYSTEM_ROLES.PRESIDENCIA;
}

const someLeadershipLocked = computed(() =>
  editableRoles.value.some((role) => leadershipLocked(role.id)),
);

/**
 * Whether this checkbox is locked: a permission to manage users or roles
 * that the role the user holds has now (giving it is fine; taking it away
 * is not), or any permission of the Secretaría and the Presidencia for
 * someone who is not an Admin.
 */
function cellLocked(roleId: string, key: PermissionKey): boolean {
  if (leadershipLocked(roleId)) return true;
  return (
    roleId === ownRoleId.value &&
    ADMIN_ACCESS_KEYS.includes(key) &&
    (saved.value[roleId] ?? []).includes(key)
  );
}

/** Some checkbox of the user's own role is locked: say why. */
const ownRoleHasLock = computed(() => {
  const roleId = ownRoleId.value;
  return (
    roleId !== null &&
    !leadershipLocked(roleId) &&
    ADMIN_ACCESS_KEYS.some((key) => cellLocked(roleId, key))
  );
});

/**
 * The unsaved draft takes some permission away from the user's own role:
 * they would lose it too, and could not give it back themselves.
 */
const ownRoleLoses = computed(() => {
  const roleId = ownRoleId.value;
  if (roleId === null) return false;
  const after = draft.value[roleId] ?? [];
  return (saved.value[roleId] ?? []).some((key) => !after.includes(key));
});

/**
 * A permission the user does not hold: they can neither give it to a role
 * nor take it away (the server refuses it, adminGrantViolation
 * `not_held`). Its whole row is locked.
 */
function notHeld(key: PermissionKey): boolean {
  return !isAdmin.value && !can(key);
}

const someNotHeld = computed(() => ALL_PERMISSION_KEYS.some(notHeld));

/** The id of the note that says why this checkbox is locked, if it is. */
function lockReasonId(roleId: string, key: PermissionKey): string | undefined {
  if (leadershipLocked(roleId)) return "roles-leadership-locked";
  if (cellLocked(roleId, key)) return "roles-own-role-locked";
  if (notHeld(key)) return "roles-not-held-locked";
  return undefined;
}

function toggle(roleId: string, key: PermissionKey, value: boolean): void {
  if (lockReasonId(roleId, key)) return;
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
    // What the user may do follows their role: reload it.
    if (roles.some((role) => role.id === ownRoleId.value)) await refreshMe();
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
    if (roles.some((role) => role.id === ownRoleId.value)) await refreshMe();
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
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
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
          v-if="ownRoleHasLock"
          id="roles-own-role-locked"
          class="text-muted flex items-start gap-1.5 text-sm"
        >
          <UIcon
            name="i-lucide-lock"
            class="mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          {{ t("admin.roles.ownAccessLocked") }}
        </p>
        <p
          v-if="someLeadershipLocked"
          id="roles-leadership-locked"
          class="text-muted flex items-start gap-1.5 text-sm"
        >
          <UIcon
            name="i-lucide-lock"
            class="mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          {{ t("admin.roles.leadershipLocked") }}
        </p>
        <p
          v-if="someNotHeld"
          id="roles-not-held-locked"
          class="text-muted flex items-start gap-1.5 text-sm"
        >
          <UIcon
            name="i-lucide-lock"
            class="mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          {{ t("admin.roles.notHeldLocked") }}
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
        :description="
          ownRoleLoses ? t('admin.roles.ownRoleLosesWarning') : undefined
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
        role="status"
      >
        <span class="sr-only">{{ t("admin.loading") }}</span>
        <USkeleton
          v-for="n in 8"
          :key="n"
          aria-hidden="true"
          class="h-10 w-full"
        />
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
                <span
                  v-if="role.id === ownRoleId"
                  class="text-muted block text-xs font-normal"
                >
                  {{ t("admin.roles.yourRole") }}
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
                <span class="text-highlighted flex items-start gap-1.5">
                  <span>{{ permissionLabel(key) }}</span>
                  <!-- One lock for the whole row: the note above says why. -->
                  <UIcon
                    v-if="notHeld(key)"
                    name="i-lucide-lock"
                    class="text-muted mt-0.5 size-3.5 shrink-0"
                    aria-hidden="true"
                  />
                </span>
              </th>
              <td
                v-for="role in editableRoles"
                :key="role.id"
                class="p-3 text-center align-middle"
              >
                <!-- The lock hangs to the side so the boxes stay aligned. -->
                <div class="relative flex items-center justify-center">
                  <UCheckbox
                    :model-value="isGranted(role.id, key)"
                    :disabled="
                      saving ||
                      !saved[role.id] ||
                      lockReasonId(role.id, key) !== undefined
                    "
                    :aria-describedby="lockReasonId(role.id, key)"
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
                  <UIcon
                    v-if="cellLocked(role.id, key)"
                    name="i-lucide-lock"
                    class="text-muted absolute start-1/2 ms-3 size-3.5"
                    aria-hidden="true"
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
