<script setup lang="ts">
import type { FormError, FormSubmitEvent, TableColumn } from "@nuxt/ui";
import { MEMBER_KINDS } from "~~/shared/constants/domain";
import type { MemberKind } from "~~/shared/constants/domain";
import type {
  IsoDate,
  MemberDto,
  MemberSyncBlockedData,
  MemberSyncBody,
  MemberSyncConfirmedKind,
  MemberSyncDeactivationKind,
  MemberSyncResult,
  RosterMemberKind,
} from "~~/shared/types/api";
import {
  MEMBER_ACRONYM_MAX_LENGTH,
  MEMBER_ACRONYM_PATTERN,
  MEMBER_DETAIL_MAX_LENGTH,
  MEMBER_NAME_MAX_LENGTH,
} from "~~/shared/utils/schemas/member";

definePageMeta({
  middleware: ["admin"],
  adminAccess: ["member:manage"],
});

/** PUT /api/members/[id] needs `updatedAt` for optimistic locking. */
type MemberRow = MemberDto & { updatedAt?: IsoDate };

type ActiveFilter = "active" | "inactive" | "all";
type KindFilter = MemberKind | "all";

interface MemberFormState {
  kind: MemberKind;
  acronym: string;
  name: string;
  university: string;
  region: string;
  active: boolean;
}

const { t, locale } = useI18n();
const toast = useToast();
const api = useApi();

useHead({ title: () => t("admin.members.title") });

const {
  data,
  status,
  error: loadError,
  refresh,
} = await useFetch<MemberRow[]>("/api/members", {
  key: "admin-members",
  query: { all: 1 },
});

const members = computed(() => data.value ?? []);

// Filters ----------------------------------------------------------------

const search = ref("");
const kindFilter = ref<KindFilter>("all");
const activeFilter = ref<ActiveFilter>("active");

const kindLabel = (kind: MemberKind) => t(`shell.memberKinds.${kind}`);

const kindFilterItems = computed(() => [
  { label: t("admin.members.allKinds"), value: "all" },
  ...MEMBER_KINDS.map((kind) => ({ label: kindLabel(kind), value: kind })),
]);

const activeFilterItems = computed(() => [
  { label: t("admin.members.onlyActive"), value: "active" },
  { label: t("admin.members.onlyInactive"), value: "inactive" },
  { label: t("admin.members.allStatuses"), value: "all" },
]);

function normalizeSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase(locale.value);
}

const filtered = computed(() => {
  const query = normalizeSearch(search.value.trim());
  return members.value.filter((member) => {
    if (kindFilter.value !== "all" && member.kind !== kindFilter.value) {
      return false;
    }
    if (activeFilter.value === "active" && !member.active) return false;
    if (activeFilter.value === "inactive" && member.active) return false;
    if (!query) return true;
    return [member.acronym, member.name, member.university, member.region]
      .filter(Boolean)
      .some((value) => normalizeSearch(value as string).includes(query));
  });
});

const hasFilters = computed(
  () =>
    search.value.trim() !== "" ||
    kindFilter.value !== "all" ||
    activeFilter.value !== "active",
);

function clearFilters(): void {
  search.value = "";
  kindFilter.value = "all";
  activeFilter.value = "active";
}

const resultSummary = computed(() =>
  t(
    "admin.members.count",
    { shown: filtered.value.length, total: members.value.length },
    members.value.length,
  ),
);

// Table ------------------------------------------------------------------

const columns = computed<TableColumn<MemberRow>[]>(() => [
  { accessorKey: "acronym", header: t("admin.members.acronym") },
  { accessorKey: "name", header: t("admin.members.name") },
  { accessorKey: "kind", header: t("admin.members.kind") },
  { accessorKey: "university", header: t("admin.members.university") },
  { accessorKey: "source", header: t("admin.members.source") },
  { accessorKey: "active", header: t("admin.members.status") },
  {
    id: "actions",
    header: () => h("span", { class: "sr-only" }, t("admin.members.actions")),
  },
]);

function formatDay(value: string | null): string {
  return value
    ? formatDateTime(value, { locale: locale.value, style: "medium" })
    : "";
}

// Sync -------------------------------------------------------------------

const syncing = ref(false);
const statusMessage = ref("");

const ROSTER_KINDS: readonly RosterMemberKind[] = ["asociado", "sectorial"];

/**
 * The kinds a refused sync would deactivate too much of: the 409 that
 * POST /api/members/sync answers with MemberSyncBlockedData. Null for any
 * other error, including the other 409s (identity changed, duplicates).
 */
function blockedSyncKinds(error: unknown): MemberSyncDeactivationKind[] | null {
  if (api.errorStatus(error) !== 409) return null;
  // ofetch keeps the response body in `data`; createError's `data` is inside.
  const body = (error as { data?: { data?: unknown } }).data?.data;
  if (!body || typeof body !== "object") return null;
  const data = body as Partial<MemberSyncBlockedData>;
  if (data.reason !== "large_deactivation" || !Array.isArray(data.kinds)) {
    return null;
  }
  const kinds = data.kinds.filter(
    (entry): entry is MemberSyncDeactivationKind =>
      Boolean(entry) &&
      ROSTER_KINDS.includes(entry.kind) &&
      Number.isInteger(entry.active) &&
      Number.isInteger(entry.toDeactivate),
  );
  return kinds.length > 0 ? kinds : null;
}

/** Set while the confirm dialog asks about a large deactivation. */
const pendingDeactivation = ref<MemberSyncDeactivationKind[] | null>(null);

const deactivationConfirmOpen = computed({
  get: () => pendingDeactivation.value !== null,
  set: (open: boolean) => {
    if (!open) pendingDeactivation.value = null;
  },
});

function deactivationLine(entry: MemberSyncDeactivationKind): string {
  const kind = t(`admin.members.largeDeactivation.kinds.${entry.kind}`);
  return entry.toDeactivate >= entry.active
    ? t(
        "admin.members.largeDeactivation.all",
        { kind, count: entry.toDeactivate },
        entry.toDeactivate,
      )
    : t("admin.members.largeDeactivation.some", {
        kind,
        count: entry.toDeactivate,
        active: entry.active,
      });
}

function sync(): Promise<void> {
  return runSync(null);
}

/**
 * Sends the sync again with the counts the dialog showed: the server applies
 * it only if it would deactivate no more than that, and asks again with the
 * new counts otherwise.
 */
function confirmDeactivation(): Promise<void> {
  const confirmed = pendingDeactivation.value;
  pendingDeactivation.value = null;
  if (!confirmed) return Promise.resolve();
  return runSync(
    confirmed.map(({ kind, toDeactivate }) => ({ kind, toDeactivate })),
  );
}

async function runSync(
  confirmedKinds: MemberSyncConfirmedKind[] | null,
): Promise<void> {
  if (syncing.value) return;
  syncing.value = true;
  statusMessage.value = t("admin.members.syncing");
  try {
    const body: MemberSyncBody | null = confirmedKinds
      ? { confirmDeactivation: true, confirmedKinds }
      : null;
    const result = await api.send<MemberSyncResult>("/api/members/sync", {
      body,
    });
    const message = t("admin.members.syncDone", {
      created: result.created,
      updated: result.updated,
      deactivated: result.deactivated,
    });
    statusMessage.value = message;
    toast.add({
      title: t("admin.members.syncDoneTitle"),
      description: message,
      color: "success",
      icon: "i-lucide-refresh-cw",
    });
    await refresh();
  } catch (error) {
    const kinds = blockedSyncKinds(error);
    if (kinds) {
      // Nothing changed: ask before deactivating that many members.
      statusMessage.value = t("admin.members.largeDeactivation.title");
      pendingDeactivation.value = kinds;
      return;
    }
    statusMessage.value = t("admin.members.syncFailed");
    api.notifyError(error, "admin.members.syncFailed");
  } finally {
    syncing.value = false;
  }
}

// Create and edit --------------------------------------------------------

const formRef = useTemplateRef("memberForm");
const formOpen = ref(false);
const saving = ref(false);
const editing = ref<MemberRow | null>(null);

const emptyState = (): MemberFormState => ({
  kind: "executive",
  acronym: "",
  name: "",
  university: "",
  region: "",
  active: true,
});

const state = reactive<MemberFormState>(emptyState());

const acronymLocked = computed(() => editing.value?.source === "intranet");

const kindItems = computed(() =>
  MEMBER_KINDS.map((kind) => ({ label: kindLabel(kind), value: kind })),
);

function openCreate(): void {
  editing.value = null;
  Object.assign(state, emptyState());
  formOpen.value = true;
}

function openEdit(member: MemberRow): void {
  editing.value = member;
  Object.assign(state, {
    kind: member.kind,
    acronym: member.acronym,
    name: member.name,
    university: member.university ?? "",
    region: member.region ?? "",
    active: member.active,
  });
  formOpen.value = true;
}

function validate(value: Partial<MemberFormState>): FormError[] {
  const errors: FormError[] = [];
  const acronym = value.acronym?.trim() ?? "";
  const name = value.name?.trim() ?? "";
  if (!acronym) {
    errors.push({
      name: "acronym",
      message: t("admin.members.errors.acronymRequired"),
    });
  } else if (
    acronym.length > MEMBER_ACRONYM_MAX_LENGTH ||
    !MEMBER_ACRONYM_PATTERN.test(acronym)
  ) {
    errors.push({
      name: "acronym",
      message: t("admin.members.errors.acronymInvalid"),
    });
  }
  if (!name) {
    errors.push({
      name: "name",
      message: t("admin.members.errors.nameRequired"),
    });
  } else if (name.length > MEMBER_NAME_MAX_LENGTH) {
    errors.push({ name: "name", message: t("admin.members.errors.tooLong") });
  }
  for (const field of ["university", "region"] as const) {
    if ((value[field]?.trim().length ?? 0) > MEMBER_DETAIL_MAX_LENGTH) {
      errors.push({ name: field, message: t("admin.members.errors.tooLong") });
    }
  }
  return errors;
}

const optional = (value: string) => value.trim() || null;

async function submit(event: FormSubmitEvent<MemberFormState>): Promise<void> {
  const values = event.data;
  const current = editing.value;
  saving.value = true;
  try {
    if (current) {
      await api.send<MemberDto>(`/api/members/${current.id}`, {
        method: "PUT",
        body: {
          ...(acronymLocked.value ? {} : { acronym: values.acronym.trim() }),
          name: values.name.trim(),
          kind: values.kind,
          active: values.active,
          university: optional(values.university),
          region: optional(values.region),
          updatedAt: current.updatedAt,
        },
      });
      statusMessage.value = t("admin.members.updated", {
        acronym: values.acronym.trim(),
      });
    } else {
      await api.send<MemberDto>("/api/members", {
        body: {
          kind: values.kind,
          acronym: values.acronym.trim(),
          name: values.name.trim(),
          university: optional(values.university),
          region: optional(values.region),
        },
      });
      statusMessage.value = t("admin.members.created", {
        acronym: values.acronym.trim(),
      });
    }
    toast.add({
      title: statusMessage.value,
      color: "success",
      icon: "i-lucide-check",
    });
    formOpen.value = false;
    await refresh();
  } catch (error) {
    const statusCode = api.errorStatus(error);
    if (statusCode === 409 && !current) {
      formRef.value?.setErrors(
        [{ name: "acronym", message: t("admin.members.errors.duplicate") }],
        "acronym",
      );
    } else if (statusCode === 409) {
      // Either the acronym is taken or someone else edited the member.
      toast.add({
        title: t("admin.members.errors.conflictTitle"),
        description: t("admin.members.errors.conflict"),
        color: "warning",
        icon: "i-lucide-refresh-ccw",
      });
      formOpen.value = false;
      await refresh();
    } else {
      api.notifyError(error, "admin.members.errors.saveFailed");
    }
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <UDashboardPanel id="admin-members">
    <template #header>
      <UDashboardNavbar :title="t('admin.members.title')">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <UButton
            icon="i-lucide-refresh-cw"
            color="neutral"
            variant="outline"
            :loading="syncing"
            @click="sync"
          >
            <span class="hidden sm:inline">{{ t("admin.members.sync") }}</span>
            <span class="sr-only sm:hidden">{{ t("admin.members.sync") }}</span>
          </UButton>
          <UButton icon="i-lucide-plus" @click="openCreate">
            <span class="hidden sm:inline">{{
              t("admin.members.create")
            }}</span>
            <span class="sr-only sm:hidden">{{
              t("admin.members.create")
            }}</span>
          </UButton>
        </template>
      </UDashboardNavbar>
      <ShellBreadcrumbs />

      <UDashboardToolbar>
        <template #left>
          <div class="flex flex-wrap items-center gap-2 py-2">
            <UInput
              v-model="search"
              icon="i-lucide-search"
              type="search"
              :placeholder="t('admin.members.search')"
              :aria-label="t('admin.members.search')"
              class="w-full sm:w-64"
            />
            <USelect
              v-model="kindFilter"
              :items="kindFilterItems"
              :aria-label="t('admin.members.kind')"
              class="w-44"
            />
            <USelect
              v-model="activeFilter"
              :items="activeFilterItems"
              :aria-label="t('admin.members.status')"
              class="w-40"
            />
          </div>
        </template>
        <template #right>
          <p
            class="text-muted hidden text-sm whitespace-nowrap md:block"
            aria-live="polite"
          >
            {{ resultSummary }}
          </p>
        </template>
      </UDashboardToolbar>
    </template>

    <template #body>
      <p class="text-muted text-sm">{{ t("admin.members.description") }}</p>

      <p class="sr-only" aria-live="polite" aria-atomic="true">
        {{ statusMessage }}
      </p>

      <UAlert
        v-if="loadError"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :title="t('admin.loadFailed')"
        :actions="[
          {
            label: t('admin.retry'),
            color: 'error',
            variant: 'outline',
            onClick: () => refresh(),
          },
        ]"
      />

      <UTable
        v-else
        :data="filtered"
        :columns="columns"
        :loading="status === 'pending' && members.length === 0"
        :aria-label="t('admin.members.title')"
        class="border-default rounded-lg border"
        :ui="{ td: 'align-middle whitespace-normal' }"
      >
        <template #acronym-cell="{ row }">
          <span class="text-highlighted font-semibold tracking-wide">
            {{ row.original.acronym }}
          </span>
        </template>

        <template #name-cell="{ row }">
          <span class="block max-w-xs min-w-48">
            {{ row.original.name }}
          </span>
          <span v-if="row.original.region" class="text-muted text-xs">
            {{ row.original.region }}
          </span>
        </template>

        <template #kind-cell="{ row }">
          <UBadge
            :label="kindLabel(row.original.kind)"
            color="neutral"
            variant="subtle"
          />
        </template>

        <template #university-cell="{ row }">
          <span v-if="row.original.university" class="text-sm">
            {{ row.original.university }}
          </span>
          <span v-else class="text-dimmed">{{ t("admin.none") }}</span>
        </template>

        <template #source-cell="{ row }">
          <UTooltip
            :text="
              row.original.syncedAt
                ? t('admin.members.syncedAt', {
                    date: formatDay(row.original.syncedAt),
                  })
                : undefined
            "
            :disabled="!row.original.syncedAt"
          >
            <UBadge
              :label="t(`admin.members.sources.${row.original.source}`)"
              :icon="
                row.original.source === 'intranet'
                  ? 'i-lucide-cloud-download'
                  : 'i-lucide-pencil'
              "
              :color="
                row.original.source === 'intranet' ? 'secondary' : 'neutral'
              "
              variant="outline"
            />
          </UTooltip>
        </template>

        <template #active-cell="{ row }">
          <UBadge
            :label="
              row.original.active
                ? t('admin.members.active')
                : t('admin.members.inactive')
            "
            :color="row.original.active ? 'success' : 'neutral'"
            variant="subtle"
          />
        </template>

        <template #actions-cell="{ row }">
          <div class="flex justify-end">
            <UTooltip :text="t('admin.members.edit')">
              <UButton
                icon="i-lucide-pencil"
                color="neutral"
                variant="ghost"
                size="sm"
                :aria-label="
                  t('admin.members.editMember', {
                    acronym: row.original.acronym,
                  })
                "
                @click="openEdit(row.original)"
              />
            </UTooltip>
          </div>
        </template>

        <template #empty>
          <CommonEmptyState
            icon="i-lucide-building-2"
            :title="
              hasFilters
                ? t('admin.members.noMatches')
                : t('admin.members.empty')
            "
            :description="
              hasFilters ? undefined : t('admin.members.emptyDescription')
            "
          >
            <template #action>
              <UButton
                v-if="hasFilters"
                color="neutral"
                variant="outline"
                icon="i-lucide-filter-x"
                @click="clearFilters"
              >
                {{ t("admin.members.clearFilters") }}
              </UButton>
              <UButton
                v-else
                icon="i-lucide-refresh-cw"
                :loading="syncing"
                @click="sync"
              >
                {{ t("admin.members.sync") }}
              </UButton>
            </template>
          </CommonEmptyState>
        </template>
      </UTable>

      <UModal
        v-model:open="formOpen"
        :title="
          editing
            ? t('admin.members.editTitle', { acronym: editing.acronym })
            : t('admin.members.createTitle')
        "
        :description="
          editing ? undefined : t('admin.members.createDescription')
        "
        :dismissible="!saving"
      >
        <template #body>
          <UForm
            id="member-form"
            ref="memberForm"
            :state="state"
            :validate="validate"
            :validate-on="['blur']"
            class="space-y-4"
            @submit="submit"
          >
            <UFormField :label="t('admin.members.kind')" name="kind" required>
              <USelect v-model="state.kind" :items="kindItems" class="w-full" />
            </UFormField>

            <UFormField
              :label="t('admin.members.acronym')"
              name="acronym"
              required
              :help="
                acronymLocked ? t('admin.members.acronymLocked') : undefined
              "
            >
              <UInput
                v-model="state.acronym"
                :disabled="acronymLocked"
                :maxlength="MEMBER_ACRONYM_MAX_LENGTH"
                autocomplete="off"
                class="w-full"
              />
            </UFormField>

            <UFormField :label="t('admin.members.name')" name="name" required>
              <UInput
                v-model="state.name"
                :maxlength="MEMBER_NAME_MAX_LENGTH"
                autocomplete="off"
                class="w-full"
              />
            </UFormField>

            <div class="grid gap-4 sm:grid-cols-2">
              <UFormField
                :label="t('admin.members.university')"
                name="university"
              >
                <UInput
                  v-model="state.university"
                  :maxlength="MEMBER_DETAIL_MAX_LENGTH"
                  class="w-full"
                />
              </UFormField>
              <UFormField :label="t('admin.members.region')" name="region">
                <UInput
                  v-model="state.region"
                  :maxlength="MEMBER_DETAIL_MAX_LENGTH"
                  class="w-full"
                />
              </UFormField>
            </div>

            <UFormField v-if="editing" name="active">
              <USwitch
                v-model="state.active"
                :label="t('admin.members.activeLabel')"
                :description="t('admin.members.activeHelp')"
              />
            </UFormField>
          </UForm>
        </template>

        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              :disabled="saving"
              @click="formOpen = false"
            >
              {{ t("admin.cancel") }}
            </UButton>
            <UButton type="submit" form="member-form" :loading="saving">
              {{ editing ? t("admin.save") : t("admin.members.createAction") }}
            </UButton>
          </div>
        </template>
      </UModal>

      <UModal
        v-model:open="deactivationConfirmOpen"
        :title="t('admin.members.largeDeactivation.title')"
      >
        <template #body>
          <div v-if="pendingDeactivation" class="space-y-3">
            <p class="text-sm">
              {{ t("admin.members.largeDeactivation.intro") }}
            </p>
            <ul class="list-disc space-y-1 ps-5 text-sm">
              <li v-for="entry in pendingDeactivation" :key="entry.kind">
                {{ deactivationLine(entry) }}
              </li>
            </ul>
            <UAlert
              color="warning"
              variant="subtle"
              icon="i-lucide-triangle-alert"
              :description="t('admin.members.largeDeactivation.warning')"
            />
          </div>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              @click="pendingDeactivation = null"
            >
              {{ t("admin.cancel") }}
            </UButton>
            <UButton
              color="warning"
              icon="i-lucide-refresh-cw"
              @click="confirmDeactivation"
            >
              {{ t("admin.members.largeDeactivation.confirm") }}
            </UButton>
          </div>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
