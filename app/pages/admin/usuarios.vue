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

interface UsersResponse {
  data: UserRow[];
  pagination: {
    page: number;
    pageSize: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
}

const toast = useToast();
const page = ref(1);
const pageSize = 50;
const {
  data: usersData,
  refresh: refreshUsers,
  status: usersStatus,
} = await useFetch<UsersResponse>("/api/admin/users", {
  query: computed(() => ({ page: page.value, pageSize })),
});

const { data: rolesData } = await useFetch<{ data: RoleOption[] }>(
  "/api/admin/roles",
);
const { data: sessionData } = await useFetch<{
  user: { id: string } | null;
}>("/api/auth/session");

const users = computed(() => usersData.value?.data ?? []);
const pagination = computed(() => usersData.value?.pagination);
const roles = computed(() => rolesData.value?.data ?? []);
const currentUserId = computed(() => sessionData.value?.user?.id ?? null);
const roleOptions = computed(() =>
  roles.value.map((r) => ({ label: r.name, value: r.id })),
);

const columns = [
  { accessorKey: "name" as const, header: t("admin.users.user") },
  { accessorKey: "role" as const, header: t("admin.users.role") },
  { accessorKey: "university" as const, header: t("admin.users.university") },
  { accessorKey: "createdAt" as const, header: t("admin.users.registeredAt") },
];

const changingRoleUserId = ref<string | null>(null);

const getRoleOption = (roleId: string | null) => {
  return roleOptions.value.find((role) => role.value === roleId);
};

const pendingRoleChange = ref<{
  userId: string;
  userName: string;
  roleName: string;
  roleId: string;
} | null>(null);

const confirmModalOpen = computed({
  get: () => pendingRoleChange.value !== null,
  set: (val: boolean) => {
    if (!val) pendingRoleChange.value = null;
  },
});

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

const handleRoleSelection = (
  userId: string,
  userName: string,
  currentRoleId: string | null,
  value: unknown,
) => {
  const roleId =
    typeof value === "string" ? value : (value as { value?: string })?.value;
  if (!roleId || roleId === currentRoleId) return;

  if (userId === currentUserId.value) {
    toast.add({
      title: t("admin.users.cannotChangeSelf"),
      color: "error",
    });
    return;
  }

  const role = roles.value.find((r) => r.id === roleId);
  if (!role) return;

  pendingRoleChange.value = { userId, userName, roleName: role.name, roleId };
};

const confirmRoleChange = async () => {
  if (!pendingRoleChange.value) return;
  const { userId, roleId } = pendingRoleChange.value;
  pendingRoleChange.value = null;
  await changeUserRole(userId, roleId);
};

const goToPreviousPage = () => {
  if (pagination.value?.hasPreviousPage) {
    page.value -= 1;
  }
};

const goToNextPage = () => {
  if (pagination.value?.hasNextPage) {
    page.value += 1;
  }
};
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

    <template v-else>
      <UTable
        :data="users"
        :columns="columns"
        :aria-label="t('admin.users.title')"
        class="mt-6"
      >
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
            :disabled="row.original.id === currentUserId"
            :placeholder="t('admin.users.noRole')"
            class="w-40"
            @update:model-value="
              (val: unknown) =>
                handleRoleSelection(
                  row.original.id,
                  row.original.name,
                  row.original.roleId,
                  val,
                )
            "
          />
        </template>

        <template #university-cell="{ row }">
          <span class="text-sm">{{ row.original.university || "-" }}</span>
        </template>

        <template #createdAt-cell="{ row }">
          <span class="text-muted text-sm">
            {{
              row.original.createdAt
                ? new Date(row.original.createdAt).toLocaleDateString()
                : "-"
            }}
          </span>
        </template>
      </UTable>

      <div class="mt-4 flex items-center justify-between gap-3">
        <p class="text-muted text-sm">
          {{ t("admin.users.page", { page: pagination?.page ?? page }) }}
        </p>
        <div class="flex gap-2">
          <UButton
            variant="soft"
            color="neutral"
            :disabled="!pagination?.hasPreviousPage"
            @click="goToPreviousPage"
          >
            {{ t("common.previous") }}
          </UButton>
          <UButton
            variant="soft"
            color="neutral"
            :disabled="!pagination?.hasNextPage"
            @click="goToNextPage"
          >
            {{ t("common.next") }}
          </UButton>
        </div>
      </div>
    </template>

    <UModal
      v-model:open="confirmModalOpen"
      :title="t('admin.users.confirmRoleChange')"
    >
      <template #body>
        <div v-if="pendingRoleChange">
          <p class="text-muted mt-2 text-sm">
            {{
              t("admin.users.confirmRoleChangeMessage", {
                user: pendingRoleChange.userName,
                role: pendingRoleChange.roleName,
              })
            }}
          </p>
          <div class="mt-4 flex justify-end gap-2">
            <UButton variant="ghost" @click="pendingRoleChange = null">
              {{ t("common.cancel") }}
            </UButton>
            <UButton
              color="primary"
              :loading="changingRoleUserId !== null"
              @click="confirmRoleChange"
            >
              {{ t("common.confirm") }}
            </UButton>
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
