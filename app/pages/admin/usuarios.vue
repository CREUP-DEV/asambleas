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
import {
  IMPERSONATION_REASON_MAX_LENGTH,
  type AccessRevokedReason,
} from "~~/shared/constants/activity";
import { IMPERSONATION_TTL_MINUTES } from "~~/shared/constants/security";
import { roleLabelKey } from "~/components/shell/RoleBadge.vue";

/**
 * People who have signed in: their role, the member they act for and the
 * permissions given to them on top of their role. Opens with
 * `user:manage_roles` (Secretaría and Presidencia hold it). Only an Admin
 * gives or takes the Administrator role: for anyone else that option and
 * the role of an Admin are locked, with the reason next to them. Only an
 * Admin changes their own role, the member their own account acts for or
 * their own extra permissions: otherwise managing users would let anyone
 * give themselves every permission. For anyone else those controls of
 * their own row stay visible but disabled, with the reason under the role.
 * An Admin who gives up the Administrator role is warned first, and the
 * last Admin cannot (409). The server refuses all of these too
 * (PUT /api/admin/users/[id]/role, /member and /permissions).
 *
 * The list reads as text and fits the width: the account (its name, with
 * its university when the name leaves it out, and its email wrap, never
 * cut), its role with the extra permissions (listed on
 * hover), the member it acts for and the last sync, with the sign-up date
 * under it. Each row's "Editar" opens a side panel with its role, its member
 * and its extra permissions; each change is confirmed and saved on its own.
 * An Admin also gets, in the row's "⋯" menu, the person's activity (the
 * Admin-only /admin/actividad, filtered by them) and "Acceder como", which
 * asks for a reason and then reloads the app as that account (POST
 * /api/admin/users/[id]/impersonate). Never for oneself nor another Admin.
 * While an Admin acts as an account that may open this page, it is
 * read-only: the server refuses every change then.
 *
 * An account that lost access to the platform (the Intranet deleted it:
 * `accessRevokedAt`) shows "Sin acceso" under its name, with the reason and
 * the date, and never offers "Acceder como" (the server refuses it too).
 * The access filter (`?access=revoked`, so it can be linked) lists only
 * those accounts; the server filters, since the list is paged.
 *
 * The search runs as the person types (300 ms after the last key): the
 * field shows a spinner while it does, and a search that finds nobody says
 * so, with a button to clear it.
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
  /**
   * When the account lost access to the platform; null (or undefined if the
   * server omits it) while it has access.
   */
  accessRevokedAt?: string | null;
  /** Why it lost access; set exactly when `accessRevokedAt` is. */
  accessRevokedReason?: AccessRevokedReason | null;
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

/** Every account, or only those that lost access to the platform. */
type AccessFilter = "all" | "revoked";

const { t, te, locale } = useI18n();
const toast = useToast();
const api = useApi();
const { me, isAdmin, can, impersonation, refresh: refreshMe } = useMe();
const { startImpersonating } = useAuth();
const localePath = useLocalePath();
const route = useRoute();
const router = useRouter();

useHead({ title: () => t("admin.users.title") });

const page = ref(1);

/**
 * The access filter, kept in the URL (`?access=revoked`) so the view can be
 * linked. Anything else in the URL means every account.
 */
const accessFilter = computed<AccessFilter>({
  get: () => {
    const raw = route.query.access;
    const value = Array.isArray(raw) ? raw[0] : raw;
    return value === "revoked" ? "revoked" : "all";
  },
  set: (value) => {
    void router.replace({
      query: {
        ...route.query,
        access: value === "revoked" ? "revoked" : undefined,
      },
    });
  },
});

// A new filter starts again from the first page. Sync, so the list is
// fetched once with both changes.
watch(
  accessFilter,
  () => {
    page.value = 1;
  },
  { flush: "sync" },
);

/**
 * The search (`?q=`, also in the URL): part of the name, the email, the
 * intranet initials or the member the account acts for. Debounced, and a new
 * search starts again from the first page.
 */
const search = ref(typeof route.query.q === "string" ? route.query.q : "");
const searchQuery = refDebounced(search, 300);
watch(searchQuery, (value) => {
  page.value = 1;
  void router.replace({
    query: { ...route.query, q: value.trim() || undefined },
  });
});

/** What the list is filtered by now, trimmed; empty with no search. */
const activeSearch = computed(() => searchQuery.value.trim());

function clearSearch(): void {
  search.value = "";
}

const accessFilterItems = computed(() => [
  { label: t("admin.users.access.all"), value: "all" },
  { label: t("admin.users.access.revokedOnly"), value: "revoked" },
]);

const {
  data: usersData,
  status: usersStatus,
  error: usersError,
  refresh: refreshUsers,
} = await useFetch<UsersResponse>("/api/admin/users", {
  key: "admin-users",
  query: computed(() => ({
    page: page.value,
    pageSize: PAGE_SIZE,
    access: accessFilter.value === "revoked" ? "revoked" : undefined,
    q: searchQuery.value.trim() || undefined,
  })),
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

const users = computed(() => usersData.value?.data ?? []);
const pagination = computed(() => usersData.value?.pagination);
const currentUserId = computed(() => me.value?.id ?? null);
const loading = computed(
  () => usersStatus.value === "pending" && users.value.length === 0,
);
/**
 * The search field shows it is working from the first key typed (the
 * debounce has not fired yet) until the list for that text arrives.
 */
const searching = computed(
  () =>
    search.value.trim() !== activeSearch.value ||
    (usersStatus.value === "pending" && activeSearch.value !== ""),
);

function roleName(name: string): string {
  const key = roleLabelKey(name);
  return key ? t(key) : name;
}

function isAdminRoleName(name: string | null | undefined): boolean {
  return name === SYSTEM_ROLES.ADMIN;
}

/** Secretaría and Presidencia: only an Admin gives, takes or changes them. */
function isLeadershipRoleName(name: string | null | undefined): boolean {
  return name === SYSTEM_ROLES.SECRETARIA || name === SYSTEM_ROLES.PRESIDENCIA;
}

/**
 * The roles to choose from. Only an Admin gives the Administrator role:
 * anyone else sees it disabled, with the reason.
 */
const roleOptions = computed(() =>
  (rolesData.value?.data ?? []).map((role) => {
    const adminOnly = !isAdmin.value && isAdminRoleName(role.name);
    const leadership = !isAdmin.value && isLeadershipRoleName(role.name);
    return {
      label: roleName(role.name),
      value: role.id,
      disabled: adminOnly || leadership,
      description: adminOnly
        ? t("admin.users.adminRoleOnlyAdmins")
        : leadership
          ? t("admin.users.leadershipRoleOnlyAdmins")
          : undefined,
    };
  }),
);

/**
 * Only an Admin takes the Administrator role away from someone, and only an
 * Admin changes the role or extra permissions of the Secretaría and the
 * Presidencia.
 */
function roleLocked(user: UserRow): boolean {
  return (
    !isAdmin.value &&
    (isAdminRoleName(user.role?.name) || isLeadershipRoleName(user.role?.name))
  );
}

function isSelf(user: UserRow): boolean {
  return user.id === currentUserId.value;
}

/**
 * Only an Admin changes their own role, member link or extra permissions.
 */
function ownAccountLocked(user: UserRow): boolean {
  return isSelf(user) && !isAdmin.value;
}

/** Why the controls of a row are locked, if they are. */
function rowLockReason(user: UserRow): string | null {
  if (ownAccountLocked(user)) return t("admin.users.selfLocked");
  if (!isAdmin.value && isLeadershipRoleName(user.role?.name)) {
    return t("admin.users.leadershipLocked");
  }
  if (roleLocked(user)) return t("admin.users.adminRoleLocked");
  return null;
}

function formatDay(value: string | null): string {
  return value
    ? formatDate(value, { locale: locale.value, style: "medium" })
    : "";
}

// Access -----------------------------------------------------------------------

/** Why an account lost access, in words; one key per reason. */
const ACCESS_REVOKED_REASON_KEYS: Record<AccessRevokedReason, string> = {
  intranet_deleted: "admin.users.access.reasons.intranetDeleted",
};

function isRevoked(user: UserRow): boolean {
  return Boolean(user.accessRevokedAt);
}

/**
 * Why the role select of a row is locked: the row's own reason, or that
 * the account has no access (its role stays Invitado until the Intranet
 * gives access back; the server refuses the change too).
 */
function roleLockReason(user: UserRow): string | null {
  return (
    rowLockReason(user) ??
    (isRevoked(user) ? t("admin.users.access.roleLocked") : null)
  );
}

/**
 * "Borrada en la Intranet el 6 nov 2026": why and since when the account
 * has no access. A reason this page does not know yet shows only the date.
 */
function revokedDetail(user: UserRow): string {
  const date = formatDay(user.accessRevokedAt ?? null);
  const key = user.accessRevokedReason
    ? ACCESS_REVOKED_REASON_KEYS[user.accessRevokedReason]
    : undefined;
  return key && te(key)
    ? t("admin.users.access.revokedOn", { reason: t(key), date })
    : t("admin.users.access.since", { date });
}

function selectAccessFilter(value: unknown): void {
  accessFilter.value = value === "revoked" ? "revoked" : "all";
}

function showAllAccounts(): void {
  accessFilter.value = "all";
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
          ? memberLabel(item)
          : t("admin.users.inactiveMember", { member: memberLabel(item) }),
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

/** Shown from a width on: narrow screens keep the account, role and actions. */
function fromWidth(breakpoint: "lg" | "xl") {
  const shown =
    breakpoint === "lg" ? "hidden lg:table-cell" : "hidden xl:table-cell";
  return { class: { th: shown, td: shown } };
}

const columns = computed<TableColumn<UserTableRow>[]>(() => [
  { accessorKey: "name", header: t("admin.users.user") },
  { id: "role", header: t("admin.users.role") },
  { id: "member", header: t("admin.users.actsFor"), meta: fromWidth("lg") },
  {
    accessorKey: "lastRoleSyncAt",
    header: t("admin.users.lastSync"),
    meta: fromWidth("xl"),
  },
  { id: "actions", header: t("admin.users.actions") },
]);

const changingUserId = ref<string | null>(null);
const pendingChange = ref<{
  userId: string;
  userName: string;
  roleId: string;
  roleName: string;
  /** An Admin changing their own role: they give up the Admin role. */
  self: boolean;
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
  if (ownAccountLocked(user)) {
    toast.add({ title: t("admin.users.selfLocked"), color: "warning" });
    selectResetKey.value += 1;
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
    userName: displayName(user),
    roleId,
    roleName: option.label,
    self: isSelf(user),
  };
}

/**
 * After an Admin changes their own role: reload what they may do and, if
 * this page no longer opens for them, leave it (every request would fail).
 */
async function afterOwnRoleChange(): Promise<void> {
  await refreshMe();
  if (!can(PERMISSION_KEYS.USER_MANAGE_ROLES)) {
    await navigateTo(localePath("/"));
    return;
  }
  await refreshUsers();
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
    if (change.self) await afterOwnRoleChange();
    else await refreshUsers();
  } catch (error) {
    // The only conflict here: the last Admin giving up the role.
    if (change.self && api.errorStatus(error) === 409) {
      toast.add({
        title: t("admin.users.roleChangeFailed"),
        description: t("admin.users.lastAdmin"),
        color: "warning",
        icon: "i-lucide-shield-alert",
      });
    } else {
      api.notifyError(error, "admin.users.roleChangeFailed");
    }
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
    userName: displayName(user),
    memberId,
    memberName: member ? memberLabel(member) : "",
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

/** Grants that add to the person's role, in catalog order. */
function extraKeys(user: UserRow): PermissionKey[] {
  const fromRole = permissionsOfRole(user.role);
  const stored = user.extraPermissions ?? [];
  return ALL_PERMISSION_KEYS.filter(
    (key) => stored.includes(key) && addsToRole(key, fromRole),
  );
}

/** How many: the "+N" badge on the row. */
function extraCount(user: UserRow): number {
  return extraKeys(user).length;
}

/** The extras in words, for the badge's tooltip and its accessible name. */
function extraLabels(user: UserRow): string[] {
  return extraKeys(user).map(permissionLabel);
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
      user: displayName(user),
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

// Activity and acting as another account (Admin only) --------------------------

/**
 * The account's name with its university when the name leaves it out:
 * many councils sign in as just "Consejo de Estudiantes".
 */
function accountName(user: UserRow): string {
  const name = user.name.trim();
  const university = user.university?.trim();
  if (!university || name.toLowerCase().includes(university.toLowerCase())) {
    return name;
  }
  return name ? `${name} · ${university}` : university;
}

/** How the page names an account: its name (and university), or its email. */
function displayName(user: UserRow): string {
  return accountName(user) || user.email;
}

/** The Admin-only activity log, filtered by this person. */
function activityLink(user: UserRow) {
  return localePath({ path: "/admin/actividad", query: { user: user.id } });
}

/**
 * Only an Admin acts as someone else: never as itself, another Admin or an
 * account without access to the platform.
 */
function canImpersonate(user: UserRow): boolean {
  return (
    isAdmin.value &&
    !impersonation.value &&
    !isSelf(user) &&
    !isAdminRoleName(user.role?.name) &&
    !isRevoked(user)
  );
}

const impersonationTarget = ref<UserRow | null>(null);
const impersonationReason = ref("");
const impersonationStarting = ref(false);
const impersonationReasonError = ref<string | undefined>(undefined);

const impersonationOpen = computed({
  get: () => impersonationTarget.value !== null,
  set: (open: boolean) => {
    if (!open && !impersonationStarting.value) impersonationTarget.value = null;
  },
});

const impersonationReasonReady = computed(
  () => impersonationReason.value.trim().length > 0,
);

function openImpersonation(user: UserRow): void {
  if (!canImpersonate(user)) return;
  impersonationReason.value = "";
  impersonationReasonError.value = undefined;
  impersonationTarget.value = user;
}

async function confirmImpersonation(): Promise<void> {
  const user = impersonationTarget.value;
  if (!user || impersonationStarting.value) return;
  if (!impersonationReasonReady.value) {
    impersonationReasonError.value = t(
      "admin.users.impersonation.reasonRequired",
    );
    return;
  }
  impersonationReasonError.value = undefined;
  impersonationStarting.value = true;
  try {
    // Reloads the app as that account; the dialog stays busy until then.
    await startImpersonating(user.id, impersonationReason.value.trim());
  } catch (error) {
    impersonationStarting.value = false;
    api.notifyError(error, "admin.users.impersonation.failed");
    // The account changed since the list loaded (it lost access, became an
    // Admin or no longer exists): close and show it as it is now.
    const status = api.errorStatus(error);
    if (status === 403 || status === 404) {
      impersonationTarget.value = null;
      await refreshUsers();
    }
  }
}

// Editing one account ------------------------------------------------------

/**
 * The account in the side panel, by id: after a change the list reloads and
 * the panel shows the account as stored. It closes if the account leaves
 * the page (another filter or page).
 */
const editUserId = ref<string | null>(null);
const editTarget = computed(
  () => rows.value.find((row) => row.id === editUserId.value) ?? null,
);
const editOpen = computed({
  get: () => editTarget.value !== null,
  set: (open: boolean) => {
    if (!open) editUserId.value = null;
  },
});

/** Read-only while an Admin acts as another account (the server refuses). */
function openEdit(user: UserRow): void {
  if (impersonation.value) return;
  editUserId.value = user.id;
  const role = user.role;
  if (role && role.name !== SYSTEM_ROLES.ADMIN) {
    void loadRolePermissions(role.id);
  }
}

/** The Admin's "⋯" menu of a row: activity, and acting as the account. */
function rowMenu(user: UserRow) {
  return [
    {
      label: t("admin.users.viewActivity"),
      icon: "i-lucide-history",
      to: activityLink(user),
    },
    ...(canImpersonate(user)
      ? [
          {
            label: t("admin.users.impersonation.button"),
            icon: "i-lucide-venetian-mask",
            color: "warning" as const,
            disabled: impersonationStarting.value,
            onSelect: () => openImpersonation(user),
          },
        ]
      : []),
  ];
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
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
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
      <ShellBreadcrumbs />

      <UDashboardToolbar>
        <template #left>
          <div class="flex flex-wrap items-center gap-2 py-2">
            <UInput
              v-model="search"
              type="search"
              icon="i-lucide-search"
              :placeholder="t('admin.users.search')"
              :aria-label="t('admin.users.search')"
              :loading="searching"
              class="w-64"
              data-testid="users-search"
            />
            <span class="sr-only" role="status">
              {{ searching ? t("admin.users.searching") : "" }}
            </span>
            <USelect
              :model-value="accessFilter"
              :items="accessFilterItems"
              icon="i-lucide-filter"
              :aria-label="t('admin.users.access.filterLabel')"
              class="w-52"
              @update:model-value="selectAccessFilter"
            />
          </div>
        </template>
      </UDashboardToolbar>
    </template>

    <template #body>
      <p class="text-muted text-sm">{{ t("admin.users.description") }}</p>
      <p
        v-if="accessFilter === 'revoked'"
        class="text-muted flex items-start gap-1.5 text-sm"
      >
        <UIcon
          name="i-lucide-user-x"
          class="mt-0.5 size-4 shrink-0"
          aria-hidden="true"
        />
        <span>{{ t("admin.users.access.filterHelp") }}</span>
      </p>
      <UAlert
        v-if="impersonation"
        color="warning"
        variant="subtle"
        icon="i-lucide-lock"
        :title="t('admin.impersonationReadOnly')"
      />
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
        :ui="{ td: 'align-middle whitespace-normal' }"
      >
        <template #name-cell="{ row }">
          <div class="flex max-w-md min-w-48 items-center gap-3">
            <UAvatar
              :src="row.original.image ?? undefined"
              :alt="displayName(row.original)"
              size="sm"
            />
            <div class="min-w-0">
              <!-- The whole name and email, on as many lines as they need. -->
              <p class="text-highlighted font-medium break-words">
                {{ accountName(row.original) }}
                <UBadge
                  v-if="row.original.id === currentUserId"
                  :label="t('admin.users.you')"
                  color="neutral"
                  variant="outline"
                  size="sm"
                  class="ms-1"
                />
              </p>
              <p class="text-muted text-xs break-all">
                {{ row.original.email }}
              </p>
              <p
                v-if="isRevoked(row.original)"
                class="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5"
              >
                <UBadge
                  :label="t('admin.users.access.revoked')"
                  color="error"
                  variant="subtle"
                  size="sm"
                  icon="i-lucide-user-x"
                />
                <span class="text-muted text-xs">
                  {{ revokedDetail(row.original) }}
                </span>
              </p>
            </div>
          </div>
        </template>

        <template #role-cell="{ row }">
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="text-sm whitespace-nowrap">
              {{
                row.original.role
                  ? roleName(row.original.role.name)
                  : t("admin.users.noRole")
              }}
            </span>
            <!-- Hover or focus lists the extras; a click opens the panel. -->
            <UTooltip
              v-if="extraCount(row.original) > 0"
              :content="{ side: 'bottom', align: 'start' }"
            >
              <UButton
                color="neutral"
                variant="outline"
                size="xs"
                icon="i-lucide-plus"
                class="whitespace-nowrap"
                :label="
                  t(
                    'admin.users.permissions.extraCount',
                    { count: extraCount(row.original) },
                    extraCount(row.original),
                  )
                "
                :aria-label="
                  t('admin.users.permissions.listFor', {
                    user: displayName(row.original),
                    list: extraLabels(row.original).join(', '),
                  })
                "
                :disabled="impersonation !== null"
                @click="openEdit(row.original)"
              />
              <template #content>
                <ul class="space-y-0.5 py-0.5 text-xs">
                  <li
                    v-for="label in extraLabels(row.original)"
                    :key="label"
                    class="flex items-center gap-1.5"
                  >
                    <UIcon
                      name="i-lucide-key-round"
                      class="size-3.5 shrink-0"
                      aria-hidden="true"
                    />
                    <span>{{ label }}</span>
                  </li>
                </ul>
              </template>
            </UTooltip>
          </div>
        </template>

        <template #member-cell="{ row }">
          <div class="max-w-64 min-w-40 space-y-1">
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

        <template #lastRoleSyncAt-cell="{ row }">
          <div class="text-sm whitespace-nowrap">
            <p v-if="row.original.lastRoleSyncAt" class="text-muted">
              {{ formatDay(row.original.lastRoleSyncAt) }}
            </p>
            <p v-else class="text-dimmed">
              {{ t("admin.users.neverSynced") }}
            </p>
            <p class="text-dimmed text-xs">
              {{
                t("admin.users.registeredOn", {
                  date: formatDay(row.original.createdAt),
                })
              }}
            </p>
          </div>
        </template>

        <template #actions-cell="{ row }">
          <div class="flex items-center gap-1">
            <UButton
              color="neutral"
              variant="outline"
              size="sm"
              icon="i-lucide-pencil"
              class="whitespace-nowrap"
              :label="t('admin.users.editAction')"
              :aria-label="
                t('admin.users.editFor', { user: displayName(row.original) })
              "
              :disabled="impersonation !== null"
              @click="openEdit(row.original)"
            />
            <!-- The activity log and acting as someone are Admin-only. -->
            <UDropdownMenu
              v-if="isAdmin"
              :items="rowMenu(row.original)"
              :content="{ align: 'end' }"
            >
              <UButton
                color="neutral"
                variant="ghost"
                size="sm"
                icon="i-lucide-ellipsis"
                :aria-label="
                  t('admin.users.moreActionsFor', {
                    user: displayName(row.original),
                  })
                "
              />
            </UDropdownMenu>
          </div>
        </template>

        <template #empty>
          <CommonEmptyState
            v-if="accessFilter === 'revoked' && !activeSearch"
            icon="i-lucide-user-check"
            :title="t('admin.users.access.noneRevoked')"
          >
            <template #action>
              <UButton
                color="neutral"
                variant="outline"
                icon="i-lucide-filter-x"
                @click="showAllAccounts"
              >
                {{ t("admin.users.access.showAll") }}
              </UButton>
            </template>
          </CommonEmptyState>
          <CommonEmptyState
            v-else-if="activeSearch"
            icon="i-lucide-search-x"
            :title="t('admin.users.noResults', { search: activeSearch })"
            :description="t('admin.users.noResultsHelp')"
            data-testid="users-no-results"
          >
            <template #action>
              <UButton
                color="neutral"
                variant="outline"
                icon="i-lucide-x"
                @click="clearSearch"
              >
                {{ t("admin.users.clearSearch") }}
              </UButton>
            </template>
          </CommonEmptyState>
          <CommonEmptyState
            v-else
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

      <!-- One account: its role, its member and its extra permissions. Each
           change is confirmed (and saved) on its own, in the dialogs below. -->
      <USlideover
        v-model:open="editOpen"
        :title="
          editTarget
            ? t('admin.users.editFor', { user: displayName(editTarget) })
            : ''
        "
        :description="t('admin.users.editingHelp')"
      >
        <template #body>
          <div v-if="editTarget" class="space-y-6">
            <div class="flex items-start gap-3">
              <UAvatar
                :src="editTarget.image ?? undefined"
                :alt="displayName(editTarget)"
                size="md"
              />
              <div class="min-w-0 space-y-0.5 text-sm">
                <p class="text-highlighted font-medium break-words">
                  {{ accountName(editTarget) }}
                </p>
                <p class="text-muted break-all">{{ editTarget.email }}</p>
                <p
                  v-if="editTarget.externalInitials || editTarget.externalRole"
                  class="text-muted"
                >
                  {{
                    t("admin.users.intranetInfo", {
                      initials: editTarget.externalInitials ?? t("admin.none"),
                      role: editTarget.externalRole ?? t("admin.none"),
                    })
                  }}
                </p>
                <UBadge
                  v-if="isRevoked(editTarget)"
                  :label="t('admin.users.access.revoked')"
                  color="error"
                  variant="subtle"
                  size="sm"
                  icon="i-lucide-user-x"
                  class="mt-1"
                />
              </div>
            </div>

            <UFormField
              :label="t('admin.users.role')"
              :help="roleLockReason(editTarget) ?? undefined"
            >
              <USelect
                :key="`${editTarget.id}-${selectResetKey}`"
                :model-value="editTarget.roleId ?? undefined"
                :items="roleOptions"
                :loading="changingUserId === editTarget.id"
                :disabled="
                  ownAccountLocked(editTarget) ||
                  roleLocked(editTarget) ||
                  isRevoked(editTarget) ||
                  changingUserId !== null
                "
                :placeholder="t('admin.users.noRole')"
                :aria-label="
                  t('admin.users.roleFor', { user: displayName(editTarget) })
                "
                class="w-full"
                @update:model-value="
                  (value: unknown) => selectRole(editTarget!, value)
                "
              />
            </UFormField>

            <UFormField :label="t('admin.users.actsFor')">
              <USelectMenu
                :key="`${editTarget.id}-${memberSelectKey}`"
                :model-value="memberValue(editTarget)"
                :items="memberOptionsFor(editTarget)"
                value-key="value"
                :loading="linkingUserId === editTarget.id"
                :disabled="
                  linkingUserId !== null || ownAccountLocked(editTarget)
                "
                :placeholder="t('admin.users.chooseMember')"
                :search-input="labelledSearch(t('admin.users.searchMember'))"
                :aria-label="
                  t('admin.users.memberFor', { user: displayName(editTarget) })
                "
                class="w-full"
                @update:model-value="
                  (value: unknown) => selectMember(editTarget!, value)
                "
              />
            </UFormField>

            <section aria-labelledby="user-edit-extras" class="space-y-2">
              <h3
                id="user-edit-extras"
                class="text-highlighted text-sm font-medium"
              >
                {{ t("admin.users.permissions.extraTitle") }}
              </h3>
              <p
                v-if="isAdminRoleName(editTarget.role?.name)"
                class="text-muted text-sm"
              >
                {{ t("admin.users.permissions.allByRole") }}
              </p>
              <ul v-else-if="extraCount(editTarget) > 0" class="space-y-1">
                <li
                  v-for="label in extraLabels(editTarget)"
                  :key="label"
                  class="flex items-center gap-1.5 text-sm"
                >
                  <UIcon
                    name="i-lucide-key-round"
                    class="text-dimmed size-4 shrink-0"
                    aria-hidden="true"
                  />
                  <span>{{ label }}</span>
                </li>
              </ul>
              <p v-else class="text-muted text-sm">
                {{ t("admin.users.permissions.summary", 0) }}
              </p>
              <!-- An Admin already has every permission: shown only to clear
                   grants stored before they became Admin. -->
              <UButton
                v-if="
                  !isAdminRoleName(editTarget.role?.name) ||
                  (editTarget.extraPermissions?.length ?? 0) > 0
                "
                color="neutral"
                variant="outline"
                size="sm"
                icon="i-lucide-key-round"
                :label="t('admin.users.permissions.change')"
                :aria-label="
                  t('admin.users.permissions.buttonFor', {
                    user: displayName(editTarget),
                  })
                "
                :disabled="
                  ownAccountLocked(editTarget) ||
                  roleLocked(editTarget) ||
                  changingUserId !== null ||
                  linkingUserId !== null
                "
                @click="openPermissions(editTarget)"
              />
            </section>
          </div>
        </template>
      </USlideover>

      <UModal
        v-model:open="confirmOpen"
        :title="t('admin.users.confirmRoleChange')"
      >
        <template #body>
          <div v-if="pendingChange" class="space-y-3">
            <p class="text-sm">
              {{
                t("admin.users.confirmRoleChangeMessage", {
                  user: pendingChange.userName,
                  role: pendingChange.roleName,
                })
              }}
            </p>
            <UAlert
              v-if="pendingChange.self"
              color="warning"
              variant="subtle"
              icon="i-lucide-shield-alert"
              :title="t('admin.users.ownAdminRoleWarningTitle')"
              :description="
                t('admin.users.ownAdminRoleWarning', {
                  role: pendingChange.roleName,
                })
              "
            />
          </div>
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
            <UButton
              :color="pendingChange?.self ? 'warning' : 'primary'"
              @click="confirmRoleChange"
            >
              {{ t("admin.confirm") }}
            </UButton>
          </div>
        </template>
      </UModal>

      <UModal
        v-model:open="permissionsOpen"
        :title="
          t('admin.users.permissions.title', {
            user: permissionsTarget ? displayName(permissionsTarget) : '',
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
              role="status"
            >
              <span class="sr-only">{{
                t("admin.users.permissions.loading")
              }}</span>
              <USkeleton
                v-for="n in 4"
                :key="n"
                aria-hidden="true"
                class="h-8 w-full"
              />
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
        v-model:open="impersonationOpen"
        :title="
          t('admin.users.impersonation.title', {
            user: impersonationTarget ? displayName(impersonationTarget) : '',
          })
        "
        :description="
          t('admin.users.impersonation.description', {
            user: impersonationTarget ? displayName(impersonationTarget) : '',
          })
        "
        :dismissible="!impersonationStarting"
      >
        <template #body>
          <form
            v-if="impersonationTarget"
            id="impersonation-form"
            class="space-y-4"
            @submit.prevent="confirmImpersonation"
          >
            <ul class="space-y-2 text-sm">
              <li class="flex items-start gap-2">
                <UIcon
                  name="i-lucide-timer"
                  class="text-muted mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
                <span>
                  {{
                    t("admin.users.impersonation.timeLimit", {
                      minutes: IMPERSONATION_TTL_MINUTES,
                    })
                  }}
                </span>
              </li>
              <li class="flex items-start gap-2">
                <UIcon
                  name="i-lucide-scroll-text"
                  class="text-muted mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
                <span>
                  {{
                    t("admin.users.impersonation.recorded", {
                      user: displayName(impersonationTarget),
                    })
                  }}
                </span>
              </li>
              <li class="flex items-start gap-2">
                <UIcon
                  name="i-lucide-lock"
                  class="text-muted mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
                <span>{{ t("admin.users.impersonation.readOnly") }}</span>
              </li>
            </ul>
            <UFormField
              :label="t('admin.users.impersonation.reason')"
              :help="
                t('admin.users.impersonation.reasonHelp', {
                  user: displayName(impersonationTarget),
                })
              "
              :hint="
                t('admin.users.impersonation.reasonCount', {
                  count: impersonationReason.length,
                  max: IMPERSONATION_REASON_MAX_LENGTH,
                })
              "
              :error="impersonationReasonError"
              name="reason"
              required
            >
              <UInput
                v-model="impersonationReason"
                :maxlength="IMPERSONATION_REASON_MAX_LENGTH"
                :disabled="impersonationStarting"
                autocomplete="off"
                required
                class="w-full"
              />
            </UFormField>
          </form>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              :disabled="impersonationStarting"
              @click="impersonationOpen = false"
            >
              {{ t("admin.cancel") }}
            </UButton>
            <UButton
              type="submit"
              form="impersonation-form"
              color="warning"
              icon="i-lucide-venetian-mask"
              :loading="impersonationStarting"
              :disabled="!impersonationReasonReady"
            >
              {{ t("admin.users.impersonation.confirm") }}
            </UButton>
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
