<script setup lang="ts">
import type { TableColumn } from "@nuxt/ui";
import type { MemberDto } from "~~/shared/types/api";
import { roleLabelKey } from "~/components/shell/RoleBadge.vue";

definePageMeta({
  middleware: ["admin"],
  adminAccess: ["admin"],
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

const { t, locale } = useI18n();
const toast = useToast();
const api = useApi();
const { me } = useMe();

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

const roleOptions = computed(() =>
  (rolesData.value?.data ?? []).map((role) => ({
    label: roleName(role.name),
    value: role.id,
  })),
);

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
  if (typeof value !== "string") return;
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
          <span v-if="!editing" class="text-sm">
            {{
              row.original.role
                ? roleName(row.original.role.name)
                : t("admin.users.noRole")
            }}
          </span>
          <USelect
            v-else
            :key="`${row.original.id}-${selectResetKey}`"
            :model-value="row.original.roleId ?? undefined"
            :items="roleOptions"
            :loading="changingUserId === row.original.id"
            :disabled="
              row.original.id === currentUserId || changingUserId !== null
            "
            :placeholder="t('admin.users.noRole')"
            :aria-label="
              t('admin.users.roleFor', {
                user: row.original.name || row.original.email,
              })
            "
            class="w-44"
            @update:model-value="
              (value: unknown) => selectRole(row.original, value)
            "
          />
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
              :disabled="linkingUserId !== null"
              :placeholder="t('admin.users.chooseMember')"
              :search-input="{ placeholder: t('admin.users.searchMember') }"
              :aria-label="
                t('admin.users.memberFor', {
                  user: row.original.name || row.original.email,
                })
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
