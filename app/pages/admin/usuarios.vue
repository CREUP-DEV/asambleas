<script setup lang="ts">
import type { TableColumn } from "@nuxt/ui";
import type { MemberDto } from "~~/shared/types/api";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import {
  ALL_PERMISSION_KEYS,
  PERMISSION_DESCRIPTION_I18N_KEYS,
  PERMISSION_KEYS,
  type PermissionKey,
} from "~~/shared/constants/permissions";
import { roleLabelKey } from "~/components/shell/RoleBadge.vue";

/**
 * People who have signed in: their role, the member they act for and the
 * permissions given to them on top of their role. Opens with
 * `user:manage_roles` (Secretaría and Presidencia hold it). Only an Admin
 * gives or takes the Administrator role: for anyone else that option and
 * the role of an Admin are locked, with the reason next to them. Nobody
 * changes their own role, and only an Admin changes the member their own
 * account acts for or their own extra permissions: otherwise managing users
 * would let anyone give themselves every permission. The server refuses all
 * of these too (PUT /api/admin/users/[id]/role, /member and /permissions).
 */
definePageMeta({
  middleware: ["admin"],
  adminAccess: ["user:manage_roles"],
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
  /** The member the account acts for; undefined if the server omits it. */
  memberId?: string | null;
  /**
   * Permissions granted to this person on top of their role
   * (user_permissions); undefined if the server omits them.
   */
  extraPermissions?: PermissionKey[];
}

/** A row of the table: the user with its linked member resolved. */
interface UserTableRow extends UserRow {
  member: MemberDto | null;
}

interface RoleOption {
  id: string;
  name: string;
}

interface UsersResponse {
  data: UserRow[];
  pagination: {
    page: number;
    pageSize: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
}

const PAGE_SIZE = 50;

const { t, te, locale } = useI18n();
const toast = useToast();
const api = useApi();
const { me, isAdmin } = useMe();

useHead({ title: () => t("admin.users.title") });

const page = ref(1);

const {
  data: usersData,
  status: usersStatus,
  error: usersError,
  refresh: refreshUsers,
} = await useFetch<UsersResponse>("/api/admin/users", {
  key: "admin-users",
  query: computed(() => ({ page: page.value, pageSize: PAGE_SIZE })),
});

const { data: rolesData } = await useFetch<{ data: RoleOption[] }>(
  "/api/admin/roles",
  { key: "admin-roles" },
);

// Every member, inactive ones too, so a link to one still shows.
const { data: membersData } = await useFetch<MemberDto[]>("/api/members", {
  key: "admin-users-members",
  query: { all: 1 },
});

// The list reads as text; the role and member selects appear only in edit
// mode, so the table stays calm and narrow on small screens.
const editing = ref(false);

const users = computed(() => usersData.value?.data ?? []);
const pagination = computed(() => usersData.value?.pagination);
const currentUserId = computed(() => me.value?.id ?? null);
const loading = computed(
  () => usersStatus.value === "pending" && users.value.length === 0,
);

function roleName(name: string): string {
  const key = roleLabelKey(name);
  return key ? t(key) : name;
}

function isAdminRoleName(name: string | null | undefined): boolean {
  return name === SYSTEM_ROLES.ADMIN;
}

/**
 * The roles to choose from. Only an Admin gives the Administrator role:
 * anyone else sees it disabled, with the reason.
 */
const roleOptions = computed(() =>
  (rolesData.value?.data ?? []).map((role) => {
    const locked = !isAdmin.value && isAdminRoleName(role.name);
    return {
      label: roleName(role.name),
      value: role.id,
      disabled: locked,
      description: locked ? t("admin.users.adminRoleOnlyAdmins") : undefined,
    };
  }),
);

/** Only an Admin takes the Administrator role away from someone. */
function roleLocked(user: UserRow): boolean {
  return !isAdmin.value && isAdminRoleName(user.role?.name);
}

function isSelf(user: UserRow): boolean {
  return user.id === currentUserId.value;
}

/**
 * Only an Admin changes their own member link or extra permissions; nobody
 * changes their own role.
 */
function ownAccountLocked(user: UserRow): boolean {
  return isSelf(user) && !isAdmin.value;
}

/** Why the controls of a row are locked, if they are. */
function rowLockReason(user: UserRow): string | null {
  if (ownAccountLocked(user)) return t("admin.users.selfLocked");
  if (isSelf(user)) return t("admin.users.cannotChangeSelf");
  if (roleLocked(user)) return t("admin.users.adminRoleLocked");
  return null;
}

function formatDay(value: string | null): string {
  return value
    ? formatDate(value, { locale: locale.value, style: "medium" })
    : "";
}

/** Sentinel for "no member" in the member select. */
const NO_MEMBER = "__none__";

const membersById = computed(
  () => new Map((membersData.value ?? []).map((item) => [item.id, item])),
);

function memberOptionsFor(user: UserRow) {
  return [
    { label: t("admin.users.noMember"), value: NO_MEMBER },
    ...(membersData.value ?? [])
      .filter((item) => item.active || item.id === user.memberId)
      .map((item) => ({
        label: item.active
          ? `${item.acronym} · ${item.name}`
          : t("admin.users.inactiveMember", {
              member: `${item.acronym} · ${item.name}`,
            }),
        value: item.id,
      })),
  ];
}

function memberValue(user: UserRow): string | undefined {
  if (user.memberId === undefined) return undefined;
  return user.memberId ?? NO_MEMBER;
}

const rows = computed<UserTableRow[]>(() =>
  users.value.map((user) => ({
    ...user,
    member: user.memberId
      ? (membersById.value.get(user.memberId) ?? null)
      : null,
  })),
);

const columns = computed<TableColumn<UserTableRow>[]>(() => [
  { accessorKey: "name", header: t("admin.users.user") },
  { id: "role", header: t("admin.users.role") },
  { id: "member", header: t("admin.users.actsFor") },
  { accessorKey: "university", header: t("admin.users.university") },
  { accessorKey: "lastRoleSyncAt", header: t("admin.users.lastSync") },
  { accessorKey: "createdAt", header: t("admin.users.registeredAt") },
]);

const changingUserId = ref<string | null>(null);
const pendingChange = ref<{
  userId: string;
  userName: string;
  roleId: string;
  roleName: string;
} | null>(null);
const statusMessage = ref("");

// Re-mounts the role selects when a change is cancelled, so they show the
// stored role again instead of the one picked.
const selectResetKey = ref(0);
watch(pendingChange, (value) => {
  if (value === null) selectResetKey.value += 1;
});

const confirmOpen = computed({
  get: () => pendingChange.value !== null,
  set: (open: boolean) => {
    if (!open) pendingChange.value = null;
  },
});

function selectRole(user: UserRow, roleId: unknown): void {
  if (typeof roleId !== "string" || roleId === user.roleId) return;
  if (user.id === currentUserId.value) {
    toast.add({ title: t("admin.users.cannotChangeSelf"), color: "warning" });
    return;
  }
  const option = roleOptions.value.find((role) => role.value === roleId);
  if (!option) return;
  if (option.disabled || roleLocked(user)) {
    toast.add({ title: t("admin.users.adminRoleLocked"), color: "warning" });
    selectResetKey.value += 1;
    return;
  }
  pendingChange.value = {
    userId: user.id,
    userName: user.name || user.email,
    roleId,
    roleName: option.label,
  };
}

async function confirmRoleChange(): Promise<void> {
  const change = pendingChange.value;
  if (!change) return;
  pendingChange.value = null;
  changingUserId.value = change.userId;
  try {
    await api.send(`/api/admin/users/${change.userId}/role`, {
      method: "PUT",
      body: { roleId: change.roleId },
    });
    const message = t("admin.users.roleChanged", {
      user: change.userName,
      role: change.roleName,
    });
    statusMessage.value = message;
    toast.add({ title: message, color: "success", icon: "i-lucide-check" });
    await refreshUsers();
  } catch (error) {
    api.notifyError(error, "admin.users.roleChangeFailed");
  } finally {
    changingUserId.value = null;
  }
}

// Member link ----------------------------------------------------------------

const linkingUserId = ref<string | null>(null);
const pendingLink = ref<{
  userId: string;
  userName: string;
  memberId: string | null;
  memberName: string;
} | null>(null);
const memberSelectKey = ref(0);
watch(pendingLink, (value) => {
  if (value === null) memberSelectKey.value += 1;
});

const linkConfirmOpen = computed({
  get: () => pendingLink.value !== null,
  set: (open: boolean) => {
    if (!open) pendingLink.value = null;
  },
});

function selectMember(user: UserRow, value: unknown): void {
  if (typeof value !== "string" || ownAccountLocked(user)) return;
  const memberId = value === NO_MEMBER ? null : value;
  if (memberId === (user.memberId ?? null)) return;
  const member = memberId ? membersById.value.get(memberId) : null;
  if (memberId && !member) return;
  pendingLink.value = {
    userId: user.id,
    userName: user.name || user.email,
    memberId,
    memberName: member ? `${member.acronym} · ${member.name}` : "",
  };
}

async function confirmMemberLink(): Promise<void> {
  const change = pendingLink.value;
  if (!change) return;
  pendingLink.value = null;
  linkingUserId.value = change.userId;
  try {
    await api.send(`/api/admin/users/${change.userId}/member`, {
      method: "PUT",
      body: { memberId: change.memberId },
    });
    const message = change.memberId
      ? t("admin.users.memberLinked", {
          user: change.userName,
          member: change.memberName,
        })
      : t("admin.users.memberUnlinked", { user: change.userName });
    statusMessage.value = message;
    toast.add({ title: message, color: "success", icon: "i-lucide-check" });
    await refreshUsers();
  } catch (error) {
    api.notifyError(error, "admin.users.memberLinkFailed");
  } finally {
    linkingUserId.value = null;
  }
}

// Extra permissions ------------------------------------------------------------

function permissionLabel(key: PermissionKey): string {
  const i18nKey = PERMISSION_DESCRIPTION_I18N_KEYS[key];
  return i18nKey && te(i18nKey) ? t(i18nKey) : key;
}

/**
 * Managing users or roles opens the administration and lets the person
 * give any permission but Administrator: said next to those two switches.
 */
const POWERFUL_PERMISSIONS: ReadonlySet<PermissionKey> = new Set([
  PERMISSION_KEYS.USER_MANAGE_ROLES,
  PERMISSION_KEYS.ROLE_MANAGE_PERMISSIONS,
]);

function permissionHelp(key: PermissionKey): string | undefined {
  return POWERFUL_PERMISSIONS.has(key)
    ? t("admin.users.permissions.powerfulHelp")
    : undefined;
}

/** Permissions each role gives, by role id. */
const rolePermissions = ref<Record<string, PermissionKey[]>>({});
/** Roles whose permissions are loading or could not be loaded, by role id. */
const roleLoad = ref<Record<string, "loading" | "failed">>({});

function setRoleLoad(roleId: string, state: "loading" | "failed" | null) {
  const next = Object.fromEntries(
    Object.entries(roleLoad.value).filter(([id]) => id !== roleId),
  );
  if (state) next[roleId] = state;
  roleLoad.value = next;
}

async function loadRolePermissions(roleId: string): Promise<void> {
  if (rolePermissions.value[roleId] || roleLoad.value[roleId] === "loading") {
    return;
  }
  setRoleLoad(roleId, "loading");
  try {
    const result = await api.get<{ permissions: PermissionKey[] }>(
      `/api/admin/roles/${encodeURIComponent(roleId)}/permissions`,
    );
    rolePermissions.value = {
      ...rolePermissions.value,
      [roleId]: result.permissions ?? [],
    };
    setRoleLoad(roleId, null);
  } catch {
    setRoleLoad(roleId, "failed");
  }
}

// The badge on each row needs every role's permissions: there are few roles,
// so they load once, in the browser. A failure only shows in the dialog.
function loadAllRolePermissions(): void {
  for (const role of rolesData.value?.data ?? []) {
    if (role.name !== SYSTEM_ROLES.ADMIN) void loadRolePermissions(role.id);
  }
}
onMounted(loadAllRolePermissions);
watch(() => rolesData.value?.data, loadAllRolePermissions);

/** What a role gives; null while it loads or if it could not be loaded. */
function permissionsOfRole(
  role: UserRow["role"] | undefined,
): PermissionKey[] | null {
  if (!role) return [];
  if (role.name === SYSTEM_ROLES.ADMIN) return [...ALL_PERMISSION_KEYS];
  return rolePermissions.value[role.id] ?? null;
}

/**
 * Whether a stored grant adds something the role does not give. Until the
 * role's permissions load, every grant counts.
 */
function addsToRole(key: PermissionKey, fromRole: PermissionKey[] | null) {
  return !(fromRole?.includes(key) ?? false);
}

/** Grants that add to the person's role: the "+N" badge on the row. */
function extraCount(user: UserRow): number {
  const fromRole = permissionsOfRole(user.role);
  return (user.extraPermissions ?? []).filter((key) =>
    addsToRole(key, fromRole),
  ).length;
}

const permissionsTarget = ref<UserRow | null>(null);
const permissionsDraft = ref<Set<PermissionKey>>(new Set());
const permissionsSaving = ref(false);

const permissionsOpen = computed({
  get: () => permissionsTarget.value !== null,
  set: (open: boolean) => {
    if (!open && !permissionsSaving.value) permissionsTarget.value = null;
  },
});

function openPermissions(user: UserRow): void {
  if (ownAccountLocked(user)) return;
  permissionsTarget.value = user;
  permissionsDraft.value = new Set(user.extraPermissions ?? []);
  const role = user.role;
  if (role && role.name !== SYSTEM_ROLES.ADMIN) {
    void loadRolePermissions(role.id);
  }
}

const targetIsAdmin = computed(
  () => permissionsTarget.value?.role?.name === SYSTEM_ROLES.ADMIN,
);

/** What the target's role already gives; null while it loads or failed. */
const targetRolePermissions = computed<PermissionKey[] | null>(() =>
  permissionsOfRole(permissionsTarget.value?.role),
);

/** Whether the dialog can list the role's permissions yet. */
const targetRoleState = computed<"ready" | "loading" | "failed">(() => {
  if (targetRolePermissions.value !== null) return "ready";
  const roleId = permissionsTarget.value?.role?.id;
  return roleId && roleLoad.value[roleId] === "failed" ? "failed" : "loading";
});

function retryRolePermissions(): void {
  const role = permissionsTarget.value?.role;
  if (role) void loadRolePermissions(role.id);
}

const includedByRole = computed(() =>
  ALL_PERMISSION_KEYS.filter((key) =>
    (targetRolePermissions.value ?? []).includes(key),
  ),
);

/**
 * What can be switched on as an extra: whatever the role does not give,
 * managing users and roles included (those open the admin pages too).
 */
const grantable = computed(() =>
  ALL_PERMISSION_KEYS.filter((key) => !includedByRole.value.includes(key)),
);

/**
 * Grants stored for the person that add nothing now, because their role
 * already gives them. They are listed so they can be removed; saving keeps
 * the ones left on.
 */
const redundantGrants = computed(() => {
  const stored = permissionsTarget.value?.extraPermissions ?? [];
  return ALL_PERMISSION_KEYS.filter(
    (key) => stored.includes(key) && includedByRole.value.includes(key),
  );
});

/** The server did not say which extras the person has: saving would guess. */
const extrasUnknown = computed(
  () =>
    permissionsTarget.value !== null &&
    permissionsTarget.value.extraPermissions === undefined,
);

const permissionsChanged = computed(() => {
  const before = new Set(permissionsTarget.value?.extraPermissions ?? []);
  const after = permissionsDraft.value;
  return (
    before.size !== after.size || [...after].some((key) => !before.has(key))
  );
});

/** Extras the person will have that the role does not already give. */
const draftExtraCount = computed(
  () => grantable.value.filter((key) => permissionsDraft.value.has(key)).length,
);

function toggleExtra(key: PermissionKey, value: boolean): void {
  const next = new Set(permissionsDraft.value);
  if (value) next.add(key);
  else next.delete(key);
  permissionsDraft.value = next;
}

async function savePermissions(): Promise<void> {
  const user = permissionsTarget.value;
  if (!user || permissionsSaving.value || extrasUnknown.value) return;
  if (ownAccountLocked(user)) return;
  permissionsSaving.value = true;
  try {
    // Grants that add nothing now (the role gives them) are kept unless
    // switched off: the role may change.
    const permissions = ALL_PERMISSION_KEYS.filter((key) =>
      permissionsDraft.value.has(key),
    );
    await api.send(
      `/api/admin/users/${encodeURIComponent(user.id)}/permissions`,
      {
        method: "PUT",
        body: { permissions },
      },
    );
    const message = t("admin.users.permissions.saved", {
      user: user.name || user.email,
    });
    statusMessage.value = message;
    toast.add({ title: message, color: "success", icon: "i-lucide-check" });
    permissionsSaving.value = false;
    permissionsTarget.value = null;
    await refreshUsers();
  } catch (error) {
    api.notifyError(error, "admin.users.permissions.saveFailed");
  } finally {
    permissionsSaving.value = false;
  }
}

function toggleEditing(): void {
  editing.value = !editing.value;
  statusMessage.value = editing.value
    ? t("admin.users.editingOn")
    : t("admin.users.editingOff");
}

function goToPage(next: number): void {
  if (next < 1) return;
  page.value = next;
}
</script>

<template>
  <UDashboardPanel id="admin-users">
    <template #header>
      <UDashboardNavbar :title="t('admin.users.title')">
        <template #right>
          <UButton
            color="neutral"
            variant="outline"
            :icon="editing ? 'i-lucide-check' : 'i-lucide-pencil'"
            :disabled="changingUserId !== null || linkingUserId !== null"
            @click="toggleEditing"
          >
            <span class="hidden sm:inline">{{
              editing ? t("admin.users.editDone") : t("admin.users.edit")
            }}</span>
            <span class="sr-only sm:hidden">{{
              editing ? t("admin.users.editDone") : t("admin.users.edit")
            }}</span>
          </UButton>
          <UButton
            icon="i-lucide-refresh-cw"
            color="neutral"
            variant="ghost"
            :loading="usersStatus === 'pending'"
            :aria-label="t('admin.refresh')"
            @click="refreshUsers()"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <p class="text-muted text-sm">{{ t("admin.users.description") }}</p>
      <p v-if="editing" class="text-muted flex items-center gap-1.5 text-sm">
        <UIcon
          name="i-lucide-pencil"
          class="size-4 shrink-0"
          aria-hidden="true"
        />
        {{ t("admin.users.editingHelp") }}
      </p>

      <p class="sr-only" aria-live="polite" aria-atomic="true">
        {{ statusMessage }}
      </p>

      <UAlert
        v-if="usersError"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :title="t('admin.loadFailed')"
        :actions="[
          {
            label: t('admin.retry'),
            color: 'error',
            variant: 'outline',
            onClick: () => refreshUsers(),
          },
        ]"
      />

      <UTable
        v-else
        :data="rows"
        :columns="columns"
        :loading="loading"
        :aria-label="t('admin.users.title')"
        class="border-default rounded-lg border"
        :ui="{ td: 'align-middle' }"
      >
        <template #name-cell="{ row }">
          <div class="flex min-w-48 items-center gap-3">
            <UAvatar
              :src="row.original.image ?? undefined"
              :alt="row.original.name || row.original.email"
              size="sm"
            />
            <div class="min-w-0">
              <p class="text-highlighted truncate font-medium">
                {{ row.original.name }}
                <UBadge
                  v-if="row.original.id === currentUserId"
                  :label="t('admin.users.you')"
                  color="neutral"
                  variant="outline"
                  size="sm"
                  class="ms-1"
                />
              </p>
              <p class="text-muted truncate text-xs">
                {{ row.original.email }}
              </p>
            </div>
          </div>
        </template>

        <template #role-cell="{ row }">
          <div v-if="!editing" class="flex flex-wrap items-center gap-1.5">
            <span class="text-sm">
              {{
                row.original.role
                  ? roleName(row.original.role.name)
                  : t("admin.users.noRole")
              }}
            </span>
            <UBadge
              v-if="extraCount(row.original) > 0"
              color="neutral"
              variant="outline"
              size="sm"
              icon="i-lucide-plus"
              :label="
                t(
                  'admin.users.permissions.extraCount',
                  { count: extraCount(row.original) },
                  extraCount(row.original),
                )
              "
            />
          </div>
          <div v-else class="space-y-1">
            <USelect
              :key="`${row.original.id}-${selectResetKey}`"
              :model-value="row.original.roleId ?? undefined"
              :items="roleOptions"
              :loading="changingUserId === row.original.id"
              :disabled="
                row.original.id === currentUserId ||
                roleLocked(row.original) ||
                changingUserId !== null
              "
              :placeholder="t('admin.users.noRole')"
              :aria-label="
                t('admin.users.roleFor', {
                  user: row.original.name || row.original.email,
                })
              "
              :aria-describedby="
                rowLockReason(row.original)
                  ? `row-locked-${row.original.id}`
                  : undefined
              "
              class="w-44"
              @update:model-value="
                (value: unknown) => selectRole(row.original, value)
              "
            />
            <p
              v-if="rowLockReason(row.original)"
              :id="`row-locked-${row.original.id}`"
              class="text-muted flex max-w-44 items-start gap-1 text-xs"
            >
              <UIcon
                name="i-lucide-lock"
                class="mt-px size-3.5 shrink-0"
                aria-hidden="true"
              />
              <span>{{ rowLockReason(row.original) }}</span>
            </p>
            <!-- Hidden, not disabled, on one's own row: the note says why. -->
            <UButton
              v-if="!ownAccountLocked(row.original)"
              color="neutral"
              variant="link"
              size="xs"
              class="px-0"
              icon="i-lucide-key-round"
              :label="
                extraCount(row.original) > 0
                  ? t(
                      'admin.users.permissions.extraCount',
                      { count: extraCount(row.original) },
                      extraCount(row.original),
                    )
                  : t('admin.users.permissions.button')
              "
              :aria-label="
                t('admin.users.permissions.buttonFor', {
                  user: row.original.name || row.original.email,
                })
              "
              :disabled="changingUserId !== null || linkingUserId !== null"
              @click="openPermissions(row.original)"
            />
          </div>
        </template>

        <template #member-cell="{ row }">
          <div class="min-w-40 space-y-1" :class="editing ? 'w-56' : ''">
            <template v-if="!editing">
              <div
                v-if="row.original.member"
                class="flex flex-wrap items-center gap-1.5"
              >
                <CommonMemberBadge :member="row.original.member" show-name />
                <UBadge
                  v-if="!row.original.member.active"
                  color="neutral"
                  variant="outline"
                  size="sm"
                  :label="t('admin.members.inactive')"
                />
              </div>
              <span v-else-if="row.original.memberId" class="text-dimmed">
                {{ t("admin.none") }}
              </span>
              <span v-else class="text-dimmed text-sm">
                {{ t("admin.users.noMember") }}
              </span>
            </template>
            <USelectMenu
              v-else
              :key="`${row.original.id}-${memberSelectKey}`"
              :model-value="memberValue(row.original)"
              :items="memberOptionsFor(row.original)"
              value-key="value"
              :loading="linkingUserId === row.original.id"
              :disabled="
                linkingUserId !== null || ownAccountLocked(row.original)
              "
              :placeholder="t('admin.users.chooseMember')"
              :search-input="{ placeholder: t('admin.users.searchMember') }"
              :aria-label="
                t('admin.users.memberFor', {
                  user: row.original.name || row.original.email,
                })
              "
              :aria-describedby="
                ownAccountLocked(row.original)
                  ? `row-locked-${row.original.id}`
                  : undefined
              "
              class="w-full"
              @update:model-value="
                (value: unknown) => selectMember(row.original, value)
              "
            />
            <p
              v-if="row.original.externalInitials || row.original.externalRole"
              class="text-muted text-xs"
            >
              {{
                t("admin.users.intranetInfo", {
                  initials: row.original.externalInitials ?? t("admin.none"),
                  role: row.original.externalRole ?? t("admin.none"),
                })
              }}
            </p>
          </div>
        </template>

        <template #university-cell="{ row }">
          <span v-if="row.original.university" class="text-sm">
            {{ row.original.university }}
          </span>
          <span v-else class="text-dimmed">{{ t("admin.none") }}</span>
        </template>

        <template #lastRoleSyncAt-cell="{ row }">
          <span v-if="row.original.lastRoleSyncAt" class="text-muted text-sm">
            {{ formatDay(row.original.lastRoleSyncAt) }}
          </span>
          <span v-else class="text-dimmed">{{
            t("admin.users.neverSynced")
          }}</span>
        </template>

        <template #createdAt-cell="{ row }">
          <span class="text-muted text-sm">
            {{ formatDay(row.original.createdAt) }}
          </span>
        </template>

        <template #empty>
          <CommonEmptyState
            icon="i-lucide-users"
            :title="t('admin.users.noUsers')"
          />
        </template>
      </UTable>

      <nav
        v-if="
          pagination && (pagination.hasNextPage || pagination.hasPreviousPage)
        "
        class="flex items-center justify-between gap-3"
        :aria-label="t('admin.pagination')"
      >
        <p class="text-muted text-sm">
          {{ t("admin.users.page", { page: pagination.page }) }}
        </p>
        <div class="flex gap-2">
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-chevron-left"
            :disabled="!pagination.hasPreviousPage"
            @click="goToPage(page - 1)"
          >
            {{ t("admin.previous") }}
          </UButton>
          <UButton
            color="neutral"
            variant="outline"
            trailing-icon="i-lucide-chevron-right"
            :disabled="!pagination.hasNextPage"
            @click="goToPage(page + 1)"
          >
            {{ t("admin.next") }}
          </UButton>
        </div>
      </nav>

      <UModal
        v-model:open="confirmOpen"
        :title="t('admin.users.confirmRoleChange')"
      >
        <template #body>
          <p v-if="pendingChange" class="text-sm">
            {{
              t("admin.users.confirmRoleChangeMessage", {
                user: pendingChange.userName,
                role: pendingChange.roleName,
              })
            }}
          </p>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              @click="pendingChange = null"
            >
              {{ t("admin.cancel") }}
            </UButton>
            <UButton color="primary" @click="confirmRoleChange">
              {{ t("admin.confirm") }}
            </UButton>
          </div>
        </template>
      </UModal>

      <UModal
        v-model:open="permissionsOpen"
        :title="
          t('admin.users.permissions.title', {
            user: permissionsTarget?.name || permissionsTarget?.email || '',
          })
        "
        :description="t('admin.users.permissions.description')"
        :dismissible="!permissionsSaving"
        :ui="{ content: 'sm:max-w-xl' }"
      >
        <template #body>
          <div v-if="permissionsTarget" class="space-y-5">
            <UAlert
              v-if="extrasUnknown"
              color="warning"
              variant="subtle"
              icon="i-lucide-triangle-alert"
              :title="t('admin.users.permissions.unknownExtras')"
            />

            <UAlert
              v-if="targetIsAdmin"
              color="neutral"
              variant="subtle"
              icon="i-lucide-shield-check"
              :title="t('admin.users.permissions.allByRole')"
            />

            <div
              v-else-if="targetRoleState === 'loading'"
              class="space-y-2"
              aria-busy="true"
              :aria-label="t('admin.users.permissions.loading')"
            >
              <USkeleton v-for="n in 4" :key="n" class="h-8 w-full" />
            </div>

            <UAlert
              v-else-if="targetRoleState === 'failed'"
              color="error"
              variant="subtle"
              icon="i-lucide-circle-alert"
              :title="t('admin.users.permissions.loadFailed')"
              :actions="[
                {
                  label: t('admin.retry'),
                  color: 'error',
                  variant: 'outline',
                  onClick: retryRolePermissions,
                },
              ]"
            />

            <template v-else>
              <section
                class="space-y-2"
                aria-labelledby="user-permissions-role"
              >
                <h3
                  id="user-permissions-role"
                  class="text-highlighted text-sm font-semibold"
                >
                  {{
                    permissionsTarget.role
                      ? t("admin.users.permissions.fromRole", {
                          role: roleName(permissionsTarget.role.name),
                        })
                      : t("admin.users.permissions.noRoleTitle")
                  }}
                </h3>
                <p v-if="!permissionsTarget.role" class="text-muted text-sm">
                  {{ t("admin.users.permissions.noRole") }}
                </p>
                <p
                  v-else-if="includedByRole.length === 0"
                  class="text-muted text-sm"
                >
                  {{ t("admin.users.permissions.fromRoleNone") }}
                </p>
                <ul v-else class="space-y-1.5">
                  <li
                    v-for="key in includedByRole"
                    :key="key"
                    class="flex items-start gap-2 text-sm"
                  >
                    <UIcon
                      name="i-lucide-check"
                      class="text-success mt-0.5 size-4 shrink-0"
                      aria-hidden="true"
                    />
                    <span>{{ permissionLabel(key) }}</span>
                  </li>
                </ul>
              </section>

              <section
                class="space-y-3"
                aria-labelledby="user-permissions-extra"
              >
                <div class="space-y-0.5">
                  <h3
                    id="user-permissions-extra"
                    class="text-highlighted text-sm font-semibold"
                  >
                    {{ t("admin.users.permissions.extraTitle") }}
                  </h3>
                  <p class="text-muted text-sm">
                    {{ t("admin.users.permissions.extraHelp") }}
                  </p>
                </div>
                <p v-if="grantable.length === 0" class="text-muted text-sm">
                  {{ t("admin.users.permissions.noneLeft") }}
                </p>
                <ul
                  v-else
                  class="border-default divide-default divide-y rounded-lg border"
                >
                  <li v-for="key in grantable" :key="key" class="px-3 py-2.5">
                    <USwitch
                      :model-value="permissionsDraft.has(key)"
                      :label="permissionLabel(key)"
                      :description="permissionHelp(key)"
                      :disabled="permissionsSaving || extrasUnknown"
                      @update:model-value="
                        (value: boolean) => toggleExtra(key, value)
                      "
                    />
                  </li>
                </ul>
              </section>
            </template>

            <!-- Grants that add nothing now, so they can be found and removed. -->
            <section
              v-if="targetRoleState === 'ready' && redundantGrants.length > 0"
              class="space-y-3"
              aria-labelledby="user-permissions-redundant"
            >
              <div class="space-y-0.5">
                <h3
                  id="user-permissions-redundant"
                  class="text-highlighted text-sm font-semibold"
                >
                  {{ t("admin.users.permissions.redundantTitle") }}
                </h3>
                <p class="text-muted text-sm">
                  {{ t("admin.users.permissions.redundantHelp") }}
                </p>
              </div>
              <ul
                class="border-default divide-default divide-y rounded-lg border"
              >
                <li
                  v-for="key in redundantGrants"
                  :key="key"
                  class="px-3 py-2.5"
                >
                  <USwitch
                    :model-value="permissionsDraft.has(key)"
                    :label="permissionLabel(key)"
                    :description="t('admin.users.permissions.coveredByRole')"
                    :disabled="permissionsSaving || extrasUnknown"
                    @update:model-value="
                      (value: boolean) => toggleExtra(key, value)
                    "
                  />
                </li>
              </ul>
            </section>
          </div>
        </template>
        <template #footer>
          <div class="flex w-full flex-wrap items-center justify-between gap-2">
            <p
              class="text-muted text-sm"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              <template
                v-if="
                  !targetIsAdmin &&
                  !extrasUnknown &&
                  targetRoleState === 'ready'
                "
              >
                {{
                  t(
                    "admin.users.permissions.summary",
                    { count: draftExtraCount },
                    draftExtraCount,
                  )
                }}
              </template>
            </p>
            <div class="flex gap-2">
              <UButton
                color="neutral"
                variant="ghost"
                :disabled="permissionsSaving"
                @click="permissionsOpen = false"
              >
                {{ t("admin.cancel") }}
              </UButton>
              <UButton
                v-if="!targetIsAdmin || redundantGrants.length > 0"
                color="primary"
                icon="i-lucide-save"
                :loading="permissionsSaving"
                :disabled="!permissionsChanged || extrasUnknown"
                @click="savePermissions"
              >
                {{ t("admin.save") }}
              </UButton>
            </div>
          </div>
        </template>
      </UModal>

      <UModal
        v-model:open="linkConfirmOpen"
        :title="t('admin.users.confirmMemberLink')"
      >
        <template #body>
          <p v-if="pendingLink" class="text-sm">
            {{
              pendingLink.memberId
                ? t("admin.users.confirmMemberLinkMessage", {
                    user: pendingLink.userName,
                    member: pendingLink.memberName,
                  })
                : t("admin.users.confirmMemberUnlinkMessage", {
                    user: pendingLink.userName,
                  })
            }}
          </p>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              @click="pendingLink = null"
            >
              {{ t("admin.cancel") }}
            </UButton>
            <UButton color="primary" @click="confirmMemberLink">
              {{ t("admin.confirm") }}
            </UButton>
          </div>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
