<script setup lang="ts">
import type { TableColumn } from "@nuxt/ui";
import { roleLabelKey } from "~/components/shell/RoleBadge.vue";
import type {
  AssemblyListDto,
  ReadState,
  StatsAccountDetailDto,
  StatsAccountDto,
  StatsAmendmentOutcomes,
  StatsDocumentDto,
  StatsDto,
  StatsMemberDto,
  StatsReadingDto,
} from "~~/shared/types/api";

/**
 * Statistics of an assembly (stats:view): what each member and each account
 * read (its read marks), presented and sent, and how each member took part
 * in the session. Read only.
 */
definePageMeta({
  middleware: ["admin"],
  adminAccess: ["stats:view"],
});

type Tab = "members" | "accounts" | "documents";

const { t, locale } = useI18n();
const localePath = useLocalePath();
const UButton = resolveComponent("UButton");

useHead({ title: () => t("admin.stats.title") });

// Assembly ---------------------------------------------------------------

const { data: assemblyList } = await useFetch<AssemblyListDto>(
  "/api/assemblies",
  { key: "admin-stats-assemblies" },
);

const assemblyItems = computed(() =>
  (assemblyList.value?.items ?? []).map((assembly) => ({
    label: assembly.label,
    value: assembly.slug,
  })),
);

// The newest assembly already convened, else the newest one.
const listed = assemblyList.value?.items ?? [];
const selectedAssembly = ref<string | undefined>(
  (listed.find((assembly) => assembly.status !== "draft") ?? listed[0])?.slug,
);

// Without any assembly there is nothing to ask for.
const {
  data,
  status,
  error: loadError,
  refresh,
} = await useFetch<StatsDto>("/api/admin/stats", {
  key: "admin-stats",
  query: computed(() => ({ assembly: selectedAssembly.value })),
  immediate: Boolean(selectedAssembly.value),
});

// Filters ----------------------------------------------------------------

const tab = ref<Tab>("members");
const search = ref("");

const tabs = computed(() => [
  {
    label: t("admin.stats.tabs.members"),
    value: "members",
    icon: "i-lucide-building-2",
  },
  {
    label: t("admin.stats.tabs.accounts"),
    value: "accounts",
    icon: "i-lucide-users",
  },
  {
    label: t("admin.stats.tabs.documents"),
    value: "documents",
    icon: "i-lucide-file-text",
  },
]);

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

function matches(...values: (string | null | undefined)[]): boolean {
  const query = normalize(search.value);
  if (!query) return true;
  return values.some((value) => value && normalize(value).includes(query));
}

const membersById = computed(
  () =>
    new Map(
      (data.value?.members ?? []).map((stats) => [
        stats.member.id,
        stats.member,
      ]),
    ),
);

const memberRows = computed(() =>
  (data.value?.members ?? []).filter((stats) =>
    matches(stats.member.acronym, stats.member.name, stats.member.university),
  ),
);

const accountRows = computed(() =>
  (data.value?.accounts ?? []).filter((account) => {
    const member = account.memberId
      ? membersById.value.get(account.memberId)
      : null;
    return matches(account.name, member?.acronym, member?.name);
  }),
);

const documentRows = computed(() =>
  (data.value?.documents ?? []).filter((document) =>
    matches(document.title, document.presenter?.acronym),
  ),
);

const summary = computed(() => {
  const totals = data.value?.totals;
  if (!totals) return "";
  return t("admin.stats.summary", {
    documents: t("admin.stats.count.documents", totals.documents),
    amendments: t("admin.stats.count.amendments", totals.amendments),
    reading: totals.readingAccounts,
    accounts: totals.accounts,
    members: totals.readingMembers,
    opening: totals.openingAccounts,
  });
});

// Formatting -------------------------------------------------------------

function percent(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

function formatDay(value: string | null): string {
  return value
    ? formatDateTime(value, { locale: locale.value, style: "medium" })
    : t("admin.stats.never");
}

function formatSeconds(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return t("admin.stats.duration", {
    minutes,
    seconds: String(rest).padStart(2, "0"),
  });
}

/** A long time: "2 h 05 min", "12 min", "40 s". */
function formatTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) {
    return t("admin.stats.time.hours", {
      hours,
      minutes: String(minutes).padStart(2, "0"),
    });
  }
  if (minutes > 0) return t("admin.stats.time.minutes", { minutes });
  return t("admin.stats.time.seconds", { seconds });
}

function roleName(name: string | null): string {
  if (!name) return t("admin.stats.noRole");
  const key = roleLabelKey(name);
  return key ? t(key) : name;
}

function memberAcronym(id: string | null): string | null {
  return id ? (membersById.value.get(id)?.acronym ?? null) : null;
}

const OUTCOME_COLORS = {
  approved: "success",
  rejected: "error",
  transacted: "info",
  submitted: "neutral",
  withdrawn: "neutral",
  lapsed: "neutral",
  inadmissible: "warning",
} as const;

function outcomes(
  values: StatsAmendmentOutcomes,
): { status: keyof StatsAmendmentOutcomes; count: number }[] {
  return (Object.keys(OUTCOME_COLORS) as (keyof StatsAmendmentOutcomes)[])
    .map((status) => ({ status, count: values[status] }))
    .filter((entry) => entry.count > 0);
}

const STATE_COLORS: Record<ReadState, "success" | "warning" | "neutral"> = {
  read: "success",
  changed: "warning",
  unread: "neutral",
};

// Columns ----------------------------------------------------------------

/** A header that sorts its column, as Nuxt UI's tables do. */
interface SortableColumn {
  getIsSorted(): false | "asc" | "desc";
  toggleSorting(desc?: boolean): void;
}

function sortable(label: string) {
  return ({ column }: { column: SortableColumn }) => {
    const sorted = column.getIsSorted();
    return h(UButton, {
      color: "neutral",
      variant: "ghost",
      label,
      icon: sorted
        ? sorted === "asc"
          ? "i-lucide-arrow-up-narrow-wide"
          : "i-lucide-arrow-down-wide-narrow"
        : "i-lucide-arrow-up-down",
      class: "-mx-2.5 font-semibold",
      "aria-label": t("admin.stats.sortBy", { column: label }),
      onClick: () => column.toggleSorting(sorted === "asc"),
    });
  };
}

const readShare = (reading: StatsReadingDto) =>
  percent(reading.documentsRead, reading.documents);

const memberColumns = computed<TableColumn<StatsMemberDto>[]>(() => [
  {
    id: "member",
    accessorFn: (row) => row.member.acronym,
    header: sortable(t("admin.stats.columns.member")),
  },
  {
    id: "documentsRead",
    accessorFn: (row) => readShare(row.reading),
    header: sortable(t("admin.stats.columns.documentsRead")),
  },
  {
    id: "amendmentsRead",
    accessorFn: (row) =>
      percent(row.reading.amendmentsRead, row.reading.amendments),
    header: sortable(t("admin.stats.columns.amendmentsRead")),
  },
  {
    id: "lastReadAt",
    accessorFn: (row) => row.reading.lastReadAt ?? "",
    header: sortable(t("admin.stats.columns.lastRead")),
  },
  {
    id: "opened",
    accessorFn: (row) => percent(row.opening.opened, row.opening.documents),
    header: sortable(t("admin.stats.columns.opened")),
  },
  {
    id: "readingTime",
    accessorFn: (row) => row.opening.seconds,
    header: sortable(t("admin.stats.columns.readingTime")),
  },
  {
    id: "documentsPresented",
    accessorKey: "documentsPresented",
    header: sortable(t("admin.stats.columns.documentsPresented")),
  },
  {
    id: "amendmentsPresented",
    accessorKey: "amendmentsPresented",
    header: sortable(t("admin.stats.columns.amendmentsPresented")),
  },
  {
    id: "outcomes",
    header: t("admin.stats.columns.outcomes"),
  },
  {
    id: "attendance",
    accessorFn: (row) => row.headcounts.inRoom + row.headcounts.delegated,
    header: sortable(t("admin.stats.columns.attendance")),
  },
  {
    id: "speaking",
    accessorFn: (row) => row.speakingSeconds,
    header: sortable(t("admin.stats.columns.speaking")),
  },
  {
    id: "accounts",
    accessorKey: "accounts",
    header: sortable(t("admin.stats.columns.accounts")),
  },
]);

const accountColumns = computed<TableColumn<StatsAccountDto>[]>(() => [
  {
    id: "name",
    accessorKey: "name",
    header: sortable(t("admin.stats.columns.account")),
  },
  {
    id: "member",
    accessorFn: (row) => memberAcronym(row.memberId) ?? "",
    header: sortable(t("admin.stats.columns.member")),
  },
  {
    id: "documentsRead",
    accessorFn: (row) => readShare(row.reading),
    header: sortable(t("admin.stats.columns.documentsRead")),
  },
  {
    id: "amendmentsRead",
    accessorFn: (row) =>
      percent(row.reading.amendmentsRead, row.reading.amendments),
    header: sortable(t("admin.stats.columns.amendmentsRead")),
  },
  {
    id: "lastReadAt",
    accessorFn: (row) => row.reading.lastReadAt ?? "",
    header: sortable(t("admin.stats.columns.lastRead")),
  },
  {
    id: "opened",
    accessorFn: (row) => percent(row.opening.opened, row.opening.documents),
    header: sortable(t("admin.stats.columns.opened")),
  },
  {
    id: "readingTime",
    accessorFn: (row) => row.opening.seconds,
    header: sortable(t("admin.stats.columns.readingTime")),
  },
  {
    id: "signIns",
    accessorKey: "signIns",
    header: sortable(t("admin.stats.columns.signIns")),
  },
  {
    id: "lastSignInAt",
    accessorFn: (row) => row.lastSignInAt ?? "",
    header: sortable(t("admin.stats.columns.lastSignIn")),
  },
  {
    id: "work",
    accessorFn: (row) => row.amendmentsSubmitted + row.documentsSubmitted,
    header: sortable(t("admin.stats.columns.sent")),
  },
]);

const documentColumns = computed<TableColumn<StatsDocumentDto>[]>(() => [
  {
    id: "title",
    accessorKey: "title",
    header: sortable(t("admin.stats.columns.document")),
  },
  {
    id: "presenter",
    accessorFn: (row) => row.presenter?.acronym ?? "",
    header: sortable(t("admin.stats.columns.presenter")),
  },
  {
    id: "readerMembers",
    accessorKey: "readerMembers",
    header: sortable(t("admin.stats.columns.readerMembers")),
  },
  {
    id: "readers",
    accessorKey: "readers",
    header: sortable(t("admin.stats.columns.readers")),
  },
  {
    id: "changed",
    accessorKey: "changed",
    header: sortable(t("admin.stats.columns.changed")),
  },
  {
    id: "openedByMembers",
    accessorKey: "openedByMembers",
    header: sortable(t("admin.stats.columns.openedByMembers")),
  },
  {
    id: "seconds",
    accessorKey: "seconds",
    header: sortable(t("admin.stats.columns.timeOpen")),
  },
  {
    id: "amendments",
    accessorKey: "amendments",
    header: sortable(t("admin.stats.columns.amendments")),
  },
]);

const memberSorting = ref([{ id: "documentsRead", desc: true }]);
const accountSorting = ref([{ id: "documentsRead", desc: true }]);
const documentSorting = ref([{ id: "readerMembers", desc: true }]);

// Account detail ----------------------------------------------------------

const detailOpen = ref(false);
const detail = ref<StatsAccountDetailDto | null>(null);
const detailLoading = ref(false);
const detailError = ref(false);
const api = useApi();

async function openDetail(account: StatsAccountDto) {
  detailOpen.value = true;
  detailLoading.value = true;
  detailError.value = false;
  detail.value = null;
  try {
    detail.value = await $fetch<StatsAccountDetailDto>(
      `/api/admin/stats/users/${encodeURIComponent(account.id)}`,
      { query: { assembly: selectedAssembly.value } },
    );
  } catch (error) {
    detailError.value = true;
    api.notifyError(error, "admin.stats.detailFailed");
  } finally {
    detailLoading.value = false;
  }
}

function documentPath(slug: string): string {
  return localePath(
    `/asambleas/${data.value?.assembly.slug ?? ""}/documentos/${slug}`,
  );
}

const detailSections = computed(() => {
  const value = detail.value;
  if (!value) return [];
  return [
    {
      key: "documents",
      title: t("admin.stats.detailDocuments"),
      kind: "document" as const,
      items: value.documents,
    },
    {
      key: "amendments",
      title: t("admin.stats.detailAmendments"),
      kind: "amendment" as const,
      items: value.amendments,
    },
  ];
});
</script>

<template>
  <UDashboardPanel id="admin-stats">
    <template #header>
      <UDashboardNavbar :title="t('admin.stats.title')">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
      <ShellBreadcrumbs />

      <UDashboardToolbar>
        <template #left>
          <div class="flex flex-wrap items-center gap-2 py-2">
            <USelect
              v-model="selectedAssembly"
              :items="assemblyItems"
              :placeholder="t('admin.stats.assembly')"
              :aria-label="t('admin.stats.assembly')"
              class="w-40"
            />
            <UInput
              v-model="search"
              icon="i-lucide-search"
              type="search"
              :placeholder="t('admin.stats.search')"
              :aria-label="t('admin.stats.search')"
              class="w-full sm:w-64"
            />
          </div>
        </template>
      </UDashboardToolbar>
    </template>

    <template #body>
      <p class="text-muted text-sm">{{ t("admin.stats.description") }}</p>

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

      <p
        v-if="summary"
        class="text-default text-sm"
        aria-live="polite"
        aria-atomic="true"
      >
        {{ summary }}
      </p>

      <UTabs
        v-model="tab"
        :items="tabs"
        :content="false"
        variant="link"
        class="w-full"
      />

      <UTable
        v-if="tab === 'members'"
        v-model:sorting="memberSorting"
        :data="memberRows"
        :columns="memberColumns"
        :loading="status === 'pending'"
        :empty="t('admin.stats.empty')"
        :aria-label="t('admin.stats.tabs.members')"
        class="border-default rounded-lg border"
        :ui="{ td: 'align-middle whitespace-normal' }"
      >
        <template #member-cell="{ row }">
          <div class="min-w-40">
            <p class="text-highlighted font-semibold tracking-wide">
              {{ row.original.member.acronym }}
              <UBadge
                v-if="!row.original.member.active"
                :label="t('admin.stats.inactive')"
                color="neutral"
                variant="subtle"
                size="sm"
              />
            </p>
            <p class="text-muted text-xs">
              {{ row.original.member.name }}
              <template v-if="row.original.member.university">
                · {{ row.original.member.university }}
              </template>
            </p>
          </div>
        </template>

        <template #documentsRead-cell="{ row }">
          <StatsReadShare
            :read="row.original.reading.documentsRead"
            :changed="row.original.reading.documentsChanged"
            :total="row.original.reading.documents"
          />
        </template>

        <template #amendmentsRead-cell="{ row }">
          <StatsReadShare
            :read="row.original.reading.amendmentsRead"
            :changed="row.original.reading.amendmentsChanged"
            :total="row.original.reading.amendments"
          />
        </template>

        <template #lastReadAt-cell="{ row }">
          <span class="text-sm whitespace-nowrap">
            {{ formatDay(row.original.reading.lastReadAt) }}
          </span>
        </template>

        <template #opened-cell="{ row }">
          <StatsReadShare
            :read="row.original.opening.opened"
            :changed="0"
            :total="row.original.opening.documents"
          />
        </template>

        <template #readingTime-cell="{ row }">
          <template v-if="row.original.opening.views > 0">
            <span class="text-sm whitespace-nowrap">
              {{ formatTime(row.original.opening.seconds) }}
            </span>
            <span class="text-muted block text-xs whitespace-nowrap">
              {{
                t("admin.stats.views", {
                  count: row.original.opening.views,
                })
              }}
            </span>
          </template>
          <span v-else class="text-dimmed text-sm">–</span>
        </template>

        <template #documentsPresented-cell="{ row }">
          <span>{{ row.original.documentsPresented }}</span>
          <span
            v-if="row.original.documentsLate > 0"
            class="text-muted block text-xs"
          >
            {{ t("admin.stats.late", row.original.documentsLate) }}
          </span>
        </template>

        <template #amendmentsPresented-cell="{ row }">
          <span>{{ row.original.amendmentsPresented }}</span>
          <span
            v-if="row.original.amendmentsPresented > 0"
            class="text-muted block text-xs whitespace-nowrap"
          >
            {{ t("admin.stats.main", row.original.amendmentsMain) }}
            <template v-if="row.original.amendmentsLate > 0">
              · {{ t("admin.stats.late", row.original.amendmentsLate) }}
            </template>
          </span>
        </template>

        <template #outcomes-cell="{ row }">
          <div class="flex max-w-56 flex-wrap gap-1">
            <UBadge
              v-for="entry in outcomes(row.original.amendmentOutcomes)"
              :key="entry.status"
              :label="`${t(`common.status.amendment.${entry.status}`)} ${entry.count}`"
              :color="OUTCOME_COLORS[entry.status]"
              variant="subtle"
              size="sm"
            />
          </div>
        </template>

        <template #attendance-cell="{ row }">
          <span
            v-if="row.original.headcounts.taken > 0"
            class="text-sm whitespace-nowrap"
          >
            {{
              t("admin.stats.attendance", {
                inRoom: row.original.headcounts.inRoom,
                taken: row.original.headcounts.taken,
              })
            }}
          </span>
          <span v-else class="text-dimmed text-sm">–</span>
          <span
            v-if="
              row.original.headcounts.delegated +
                row.original.headcounts.received >
              0
            "
            class="text-muted block text-xs whitespace-nowrap"
          >
            {{
              t("admin.stats.delegations", {
                gave: row.original.headcounts.delegated,
                received: row.original.headcounts.received,
              })
            }}
          </span>
        </template>

        <template #speaking-cell="{ row }">
          <span v-if="row.original.speakingTurns > 0" class="whitespace-nowrap">
            {{ t("admin.stats.turns", row.original.speakingTurns) }}
            <span class="text-muted block text-xs">
              {{ formatSeconds(row.original.speakingSeconds) }}
            </span>
          </span>
          <span v-else class="text-dimmed text-sm">–</span>
        </template>
      </UTable>

      <UTable
        v-else-if="tab === 'accounts'"
        v-model:sorting="accountSorting"
        :data="accountRows"
        :columns="accountColumns"
        :loading="status === 'pending'"
        :empty="t('admin.stats.empty')"
        :aria-label="t('admin.stats.tabs.accounts')"
        class="border-default rounded-lg border"
        :ui="{ td: 'align-middle whitespace-normal' }"
      >
        <template #name-cell="{ row }">
          <div class="flex max-w-xs min-w-48 items-center gap-3">
            <CommonAccountAvatar
              :src="row.original.image"
              :alt="row.original.name"
              :text="row.original.avatarText"
              :online="row.original.online"
            />
            <div class="min-w-0">
              <button
                type="button"
                class="text-highlighted text-left font-medium break-words hover:underline focus-visible:underline"
                :aria-label="
                  t('admin.stats.openDetail', { account: row.original.name })
                "
                @click="openDetail(row.original)"
              >
                {{ row.original.name }}
              </button>
              <p class="text-muted text-xs">
                {{ roleName(row.original.role) }}
                <template v-if="row.original.revoked">
                  · {{ t("admin.stats.revoked") }}
                </template>
              </p>
            </div>
          </div>
        </template>

        <template #member-cell="{ row }">
          <span
            v-if="memberAcronym(row.original.memberId)"
            class="font-semibold tracking-wide"
          >
            {{ memberAcronym(row.original.memberId) }}
          </span>
          <span v-else class="text-dimmed text-sm">–</span>
        </template>

        <template #documentsRead-cell="{ row }">
          <StatsReadShare
            :read="row.original.reading.documentsRead"
            :changed="row.original.reading.documentsChanged"
            :total="row.original.reading.documents"
          />
        </template>

        <template #amendmentsRead-cell="{ row }">
          <StatsReadShare
            :read="row.original.reading.amendmentsRead"
            :changed="row.original.reading.amendmentsChanged"
            :total="row.original.reading.amendments"
          />
        </template>

        <template #lastReadAt-cell="{ row }">
          <span class="text-sm whitespace-nowrap">
            {{ formatDay(row.original.reading.lastReadAt) }}
          </span>
        </template>

        <template #opened-cell="{ row }">
          <StatsReadShare
            :read="row.original.opening.opened"
            :changed="0"
            :total="row.original.opening.documents"
          />
        </template>

        <template #readingTime-cell="{ row }">
          <template v-if="row.original.opening.views > 0">
            <span class="text-sm whitespace-nowrap">
              {{ formatTime(row.original.opening.seconds) }}
            </span>
            <span class="text-muted block text-xs whitespace-nowrap">
              {{
                t("admin.stats.views", {
                  count: row.original.opening.views,
                })
              }}
            </span>
          </template>
          <span v-else class="text-dimmed text-sm">–</span>
        </template>

        <template #lastSignInAt-cell="{ row }">
          <span class="text-sm whitespace-nowrap">
            {{ formatDay(row.original.lastSignInAt) }}
          </span>
        </template>

        <template #work-cell="{ row }">
          <span class="text-sm whitespace-nowrap">
            {{
              t("admin.stats.sentDetail", {
                amendments: row.original.amendmentsSubmitted,
                documents: row.original.documentsSubmitted,
              })
            }}
          </span>
          <span
            v-if="row.original.amendmentsWritten > 0"
            class="text-muted block text-xs"
          >
            {{ t("admin.stats.written", row.original.amendmentsWritten) }}
          </span>
        </template>
      </UTable>

      <UTable
        v-else
        v-model:sorting="documentSorting"
        :data="documentRows"
        :columns="documentColumns"
        :loading="status === 'pending'"
        :empty="t('admin.stats.empty')"
        :aria-label="t('admin.stats.tabs.documents')"
        class="border-default rounded-lg border"
        :ui="{ td: 'align-middle whitespace-normal' }"
      >
        <template #title-cell="{ row }">
          <div class="max-w-md min-w-56">
            <ULink
              :to="documentPath(row.original.slug)"
              class="text-highlighted font-medium hover:underline"
            >
              {{ row.original.title }}
            </ULink>
            <p class="text-muted text-xs">
              {{ t(`agenda.documentKinds.${row.original.kind}`) }}
            </p>
          </div>
        </template>

        <template #presenter-cell="{ row }">
          <span
            v-if="row.original.presenter"
            class="font-semibold tracking-wide"
          >
            {{ row.original.presenter.acronym }}
          </span>
          <span v-else class="text-dimmed text-sm">–</span>
        </template>

        <template #openedByMembers-cell="{ row }">
          <span>{{ row.original.openedByMembers }}</span>
          <span
            v-if="row.original.openedBy > 0"
            class="text-muted block text-xs whitespace-nowrap"
          >
            {{
              t("admin.stats.openedByAccounts", {
                accounts: row.original.openedBy,
                views: row.original.views,
              })
            }}
          </span>
        </template>

        <template #seconds-cell="{ row }">
          <span
            v-if="row.original.seconds > 0"
            class="text-sm whitespace-nowrap"
          >
            {{ formatTime(row.original.seconds) }}
          </span>
          <span v-else class="text-dimmed text-sm">–</span>
        </template>
      </UTable>

      <USlideover
        v-model:open="detailOpen"
        :title="detail?.account.name ?? t('admin.stats.detail')"
        :description="
          detail
            ? [roleName(detail.account.role), detail.member?.acronym]
                .filter(Boolean)
                .join(' · ')
            : undefined
        "
        :ui="{ content: 'max-w-xl' }"
      >
        <template #body>
          <div
            v-if="detailLoading"
            class="text-muted flex items-center gap-2 text-sm"
          >
            <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
            {{ t("admin.stats.loading") }}
          </div>
          <p v-else-if="detailError" class="text-muted text-sm">
            {{ t("admin.stats.detailFailed") }}
          </p>
          <div v-else-if="detail" class="space-y-6">
            <dl class="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt class="text-muted">
                  {{ t("admin.stats.columns.signIns") }}
                </dt>
                <dd class="text-highlighted font-medium">
                  {{ detail.account.signIns }}
                </dd>
              </div>
              <div>
                <dt class="text-muted">
                  {{ t("admin.stats.columns.lastSignIn") }}
                </dt>
                <dd class="text-highlighted font-medium">
                  {{ formatDay(detail.account.lastSignInAt) }}
                </dd>
              </div>
              <div>
                <dt class="text-muted">
                  {{ t("admin.stats.columns.documentsRead") }}
                </dt>
                <dd>
                  <StatsReadShare
                    :read="detail.account.reading.documentsRead"
                    :changed="detail.account.reading.documentsChanged"
                    :total="detail.account.reading.documents"
                  />
                </dd>
              </div>
              <div>
                <dt class="text-muted">
                  {{ t("admin.stats.columns.amendmentsRead") }}
                </dt>
                <dd>
                  <StatsReadShare
                    :read="detail.account.reading.amendmentsRead"
                    :changed="detail.account.reading.amendmentsChanged"
                    :total="detail.account.reading.amendments"
                  />
                </dd>
              </div>
            </dl>

            <section v-for="section in detailSections" :key="section.key">
              <h3 class="text-highlighted mb-2 text-sm font-semibold">
                {{ section.title }}
              </h3>
              <p v-if="section.items.length === 0" class="text-muted text-sm">
                {{ t("admin.stats.nothingPublished") }}
              </p>
              <ul v-else class="divide-default divide-y text-sm">
                <li
                  v-for="item in section.items"
                  :key="item.id"
                  class="flex items-start justify-between gap-3 py-2"
                >
                  <div class="min-w-0">
                    <ULink
                      :to="documentPath(item.slug)"
                      class="text-default hover:underline"
                    >
                      {{ item.label }}
                    </ULink>
                    <p v-if="item.documentTitle" class="text-muted text-xs">
                      {{ item.documentTitle }}
                    </p>
                    <p v-if="item.readAt" class="text-muted text-xs">
                      {{
                        t("admin.stats.markedOn", {
                          date: formatDay(item.readAt),
                        })
                      }}
                    </p>
                    <p v-if="item.views > 0" class="text-muted text-xs">
                      {{
                        t("admin.stats.openedDetail", {
                          count: item.views,
                          time: formatTime(item.seconds),
                          date: formatDay(item.firstOpenedAt),
                        })
                      }}
                    </p>
                    <p
                      v-else-if="section.kind === 'document' && !item.own"
                      class="text-muted text-xs"
                    >
                      {{ t("admin.stats.neverOpened") }}
                    </p>
                  </div>
                  <UBadge
                    :label="
                      item.own
                        ? t('admin.stats.own')
                        : t(`readMarks.${item.state}.${section.kind}`)
                    "
                    :color="item.own ? 'neutral' : STATE_COLORS[item.state]"
                    variant="subtle"
                    size="sm"
                    class="shrink-0"
                  />
                </li>
              </ul>
            </section>
          </div>
        </template>
      </USlideover>
    </template>
  </UDashboardPanel>
</template>
