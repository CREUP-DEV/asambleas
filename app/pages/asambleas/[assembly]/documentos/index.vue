<script setup lang="ts">
import { DOCUMENT_KINDS } from "~~/shared/constants/domain";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type { DocumentSummaryDto } from "~~/shared/types/api";
import { hasSomethingLeft } from "~~/shared/utils/readMarks";
import {
  documentProgress,
  PROGRESS_LABEL_ORDER,
} from "~/composables/document/documentProgress";
import {
  documentPresenterMembers,
  isDocumentPresenter,
} from "~/composables/document/documentPresenters";

/**
 * Every document of the assembly in agenda order, with search and filters.
 * The agenda page shows the same documents inside the item tree; this list
 * is the quick way to find one and see where its amendments stand.
 *
 * Before publication each row says where the document stands and, for the
 * user's own drafts, what to do next (with the internal deadline of the
 * documents the Secretaría expects). "Solo los míos" narrows the list to the
 * documents the user's member presents, alone or with others; the search
 * also finds a document by any of its presenters. The status filter offers the same
 * names as the badges ("Enviado a Secretaría", "Corrección pedida", "Fuera
 * de plazo"...), only those that some document has, and shows only when
 * there are two or more to choose from. "Solo lo que me queda
 * por leer" keeps the documents the account has not marked as read, or that
 * have amendments it has not read. "Descargar documentación" offers the
 * package of everything published, as the overview and the agenda do.
 *
 * Whoever manages documents edits a document's record (title, kind,
 * presenters, rules…) from its row, «Editar la ficha», in a side panel
 * (DocumentRecordDialog; user's decision of 2026-11-21) without opening
 * the document; the list reads itself again once saved.
 */

const { t } = useI18n();
const me = useMe();
const now = useAppNow();
const current = useCurrentAssembly();
const { assembly, sectionPath } = current;
/** The documentation package's dialog (ExportPackageDialog). */
const packageOpen = ref(false);

useHead({
  title: () =>
    [t("documents.title"), assembly.value?.label].filter(Boolean).join(" · "),
});

const { data: agenda, pending, error, refresh } = await useAssemblyAgenda();

const numbers = computed(
  () =>
    new Map(
      flattenAgendaTree(buildAgendaTree(agenda.value?.items ?? [])).map(
        (node) => [node.item.id, node.number],
      ),
    ),
);
const itemTitles = computed(
  () =>
    new Map((agenda.value?.items ?? []).map((item) => [item.id, item.title])),
);

const search = ref("");
const status = ref<string>("all");
const kind = ref<string>("all");
const onlyMine = ref(false);
const onlyLeft = ref(false);

const marks = useReadMarks();
const isLeft = (document: DocumentSummaryDto) =>
  hasSomethingLeft(marks.index.value, document.id);
const leftCount = computed(
  () => (agenda.value?.documents ?? []).filter(isLeft).length,
);
/** The read marks are on their way (fetched in the browser only). */
const marksWaiting = computed(
  () => marks.marks.value === null && !marks.failed.value,
);

/**
 * A filter switch on a phone answers in its whole row (M-031): the label
 * stretches over the row's height and the rest of its width, and the
 * switch's own button reaches the row's top and bottom.
 */
const FILTER_SWITCH_UI = {
  root: "max-sm:min-h-11 items-center",
  base: "max-sm:relative max-sm:after:absolute max-sm:after:-inset-x-2 max-sm:after:-inset-y-3",
  wrapper: "max-sm:flex max-sm:flex-1 max-sm:self-stretch",
  label: "max-sm:flex max-sm:flex-1 max-sm:items-center cursor-pointer",
};

const memberId = computed(() => me.member.value?.id ?? null);
const isMine = (document: DocumentSummaryDto) =>
  isDocumentPresenter(document, memberId.value);
const mineCount = computed(
  () => (agenda.value?.documents ?? []).filter(isMine).length,
);

/**
 * The badge each document shows (its progress label key), which is also
 * what the status filter matches: one name per status everywhere. The
 * label does not depend on who is looking.
 */
const statusKeys = computed(
  () =>
    new Map(
      (agenda.value?.documents ?? []).map((document) => [
        document.id,
        documentProgress(document, "other", now.value).labelKey,
      ]),
    ),
);

const statusItems = computed(() => {
  const present = new Set(statusKeys.value.values());
  // Keep the chosen one even if a refresh emptied it.
  if (status.value !== "all") present.add(status.value);
  return [
    { label: t("documents.allStatuses"), value: "all" },
    ...PROGRESS_LABEL_ORDER.filter((key) => present.has(key)).map((key) => ({
      label: t(key),
      value: key,
    })),
  ];
});
/**
 * Only when it can tell documents apart: someone who reads only what is
 * published would get just "Publicado". Kept while a status is chosen, so
 * it can be cleared.
 */
const showStatusFilter = computed(
  () => statusItems.value.length > 2 || status.value !== "all",
);
const kindItems = computed(() => [
  { label: t("documents.allKinds"), value: "all" },
  ...DOCUMENT_KINDS.map((value) => ({
    label: t(`agenda.documentKinds.${value}`),
    value,
  })),
]);

function normalized(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("es");
}

const filtered = computed<DocumentSummaryDto[]>(() => {
  const query = normalized(search.value.trim());
  return (agenda.value?.documents ?? []).filter((document) => {
    if (onlyMine.value && !isMine(document)) return false;
    if (onlyLeft.value && !isLeft(document)) return false;
    if (
      status.value !== "all" &&
      statusKeys.value.get(document.id) !== status.value
    ) {
      return false;
    }
    if (kind.value !== "all" && document.kind !== kind.value) return false;
    if (!query) return true;
    return [
      document.title,
      document.reference ?? "",
      ...documentPresenterMembers(document).flatMap((member) => [
        member.acronym,
        member.name,
      ]),
    ].some((field) => normalized(field).includes(query));
  });
});

/** Documents grouped under their agenda item, in agenda order. */
const groups = computed(() => {
  const order = [...numbers.value.keys()];
  const byItem = new Map<string, DocumentSummaryDto[]>();
  for (const document of filtered.value) {
    const list = byItem.get(document.agendaItemId);
    if (list) list.push(document);
    else byItem.set(document.agendaItemId, [document]);
  }
  return [...byItem.entries()]
    .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
    .map(([itemId, documents]) => ({
      itemId,
      number: numbers.value.get(itemId) ?? null,
      // An item of the agenda without a number: not everyone gets it yet.
      unlisted: numbers.value.get(itemId) === null,
      title: itemTitles.value.get(itemId) ?? "",
      documents,
    }));
});

const total = computed(() => agenda.value?.documents.length ?? 0);
const filtering = computed(
  () =>
    search.value.trim() !== "" ||
    status.value !== "all" ||
    kind.value !== "all" ||
    onlyMine.value ||
    onlyLeft.value,
);

/**
 * On a phone the search and «Solo lo que me queda por leer» stay in view
 * and the rest fold behind «Filtros», so the list starts high.
 */
const filtersOpen = ref(false);
const filtersId = useId();
const foldedActive = computed(
  () =>
    Number(status.value !== "all") +
    Number(kind.value !== "all") +
    Number(onlyMine.value),
);

function resetFilters() {
  search.value = "";
  status.value = "all";
  kind.value = "all";
  onlyMine.value = false;
  onlyLeft.value = false;
}

/** Whoever manages documents edits their record from the list. */
const canEditRecords = computed(() => me.can(PERMISSION_KEYS.DOCUMENT_MANAGE));
const recordOpen = ref(false);
const recordDocument = ref<DocumentSummaryDto | null>(null);
function openRecord(document: DocumentSummaryDto): void {
  recordDocument.value = document;
  recordOpen.value = true;
}

function documentPath(document: DocumentSummaryDto): string {
  return sectionPath(`documentos/${encodeURIComponent(document.slug)}`);
}

/**
 * The editor of the user's own draft (its presenters, main or co-presenters,
 * may edit it); managers open documents in the workspace like everyone else.
 */
function documentEditPath(document: DocumentSummaryDto): string | null {
  if (
    document.status !== "draft" ||
    !isMine(document) ||
    me.can(PERMISSION_KEYS.DOCUMENT_MANAGE)
  ) {
    return null;
  }
  return `${documentPath(document)}/editar`;
}
</script>

<template>
  <div v-if="assembly" class="space-y-6">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0 space-y-1">
        <h2 class="text-highlighted text-xl font-semibold">
          {{ t("documents.title") }}
        </h2>
        <p class="text-muted text-sm">
          {{ t("agenda.documentsCount", total) }}
        </p>
      </div>
      <!-- Only their icons below sm, their names still read out, so they
           stay on the title's line. -->
      <div class="flex flex-wrap items-center gap-2">
        <UButton
          v-if="assembly.status !== 'draft'"
          color="neutral"
          variant="outline"
          icon="i-lucide-folder-down"
          :label="t('assembly.package.button')"
          class="max-sm:px-1.5"
          :ui="{ label: 'max-sm:sr-only' }"
          data-testid="documents-package"
          @click="packageOpen = true"
        />
        <UButton
          color="neutral"
          variant="outline"
          icon="i-lucide-list-tree"
          :label="t('documents.byAgenda')"
          class="max-sm:px-1.5"
          :ui="{ label: 'max-sm:sr-only' }"
          :to="sectionPath('orden-del-dia')"
        />
      </div>
    </div>

    <ExportPackageDialog
      v-model:open="packageOpen"
      :api-base="current.apiBase.value"
    />

    <!-- One row from sm, wrapping before the search shrinks; on a phone the
         search with «Filtros» beside it, and the switch used most. -->
    <div
      v-if="total > 0"
      class="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center"
      role="search"
    >
      <div class="flex items-center gap-2 sm:contents">
        <UInput
          v-model="search"
          icon="i-lucide-search"
          :placeholder="t('documents.searchPlaceholder')"
          :aria-label="t('documents.searchLabel')"
          class="min-w-0 flex-1 sm:max-w-sm sm:min-w-64"
          :ui="{ base: 'max-sm:h-10' }"
        />
        <UButton
          color="neutral"
          variant="outline"
          icon="i-lucide-list-filter"
          :trailing-icon="
            filtersOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'
          "
          class="h-10 shrink-0 sm:hidden"
          :aria-expanded="filtersOpen"
          :aria-controls="filtersId"
          @click="filtersOpen = !filtersOpen"
        >
          {{
            foldedActive > 0
              ? t("documents.filtersCount", { count: foldedActive })
              : t("documents.filters")
          }}
        </UButton>
      </div>
      <div
        :id="filtersId"
        class="flex-col gap-2 sm:contents"
        :class="filtersOpen ? 'flex' : 'hidden'"
      >
        <USelect
          v-if="showStatusFilter"
          v-model="status"
          :items="statusItems"
          :aria-label="t('documents.statusFilter')"
          class="sm:w-56"
        />
        <USelect
          v-model="kind"
          :items="kindItems"
          :aria-label="t('documents.kindFilter')"
          class="sm:w-56"
        />
        <USwitch
          v-if="mineCount > 0"
          v-model="onlyMine"
          size="sm"
          :ui="FILTER_SWITCH_UI"
          :label="
            t('documents.onlyMine', { member: me.member.value?.acronym ?? '' })
          "
        />
      </div>
      <!-- Names the dot the rows show for what is left to read. On a phone,
           while the marks are on their way, its row is kept, so the list
           does not move down when it comes. -->
      <USwitch
        v-if="leftCount > 0 || onlyLeft"
        v-model="onlyLeft"
        size="sm"
        :ui="FILTER_SWITCH_UI"
        :label="t('readMarks.onlyLeft', { count: leftCount })"
        data-testid="documents-only-left"
      >
        <template #label="{ label }">
          <span class="inline-flex items-center gap-1.5">
            <span
              class="bg-primary size-2 shrink-0 rounded-full"
              aria-hidden="true"
            />
            {{ label }}
          </span>
        </template>
      </USwitch>
      <div
        v-else-if="marksWaiting"
        class="flex min-h-11 items-center sm:hidden"
        aria-hidden="true"
      >
        <USkeleton class="h-4 w-60 max-w-full" />
      </div>
      <UButton
        v-if="filtering"
        color="neutral"
        variant="ghost"
        icon="i-lucide-x"
        :label="t('documents.clearFilters')"
        @click="resetFilters"
      />
    </div>

    <div v-if="pending && !agenda" class="space-y-3" role="status">
      <span class="sr-only">{{ t("common.loading") }}</span>
      <USkeleton
        v-for="n in 3"
        :key="n"
        aria-hidden="true"
        class="h-16 w-full"
      />
    </div>

    <UAlert
      v-else-if="error && !agenda"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :title="t('agenda.loadError')"
      :actions="[
        {
          label: t('agenda.retry'),
          color: 'error',
          variant: 'outline',
          onClick: () => refresh(),
        },
      ]"
    />

    <CommonEmptyState
      v-else-if="total === 0"
      icon="i-lucide-files"
      :title="t('documents.emptyTitle')"
      :description="t('documents.emptyDescription')"
    >
      <template #action>
        <UButton
          color="neutral"
          variant="outline"
          icon="i-lucide-list-tree"
          :label="t('documents.byAgenda')"
          :to="sectionPath('orden-del-dia')"
        />
      </template>
    </CommonEmptyState>

    <CommonEmptyState
      v-else-if="filtered.length === 0"
      icon="i-lucide-search-x"
      :title="t('documents.noMatchesTitle')"
      :description="t('documents.noMatchesDescription')"
    >
      <template #action>
        <UButton
          color="neutral"
          variant="outline"
          :label="t('documents.clearFilters')"
          @click="resetFilters"
        />
      </template>
    </CommonEmptyState>

    <div v-else class="space-y-6">
      <section
        v-for="group in groups"
        :key="group.itemId"
        :aria-labelledby="`documents-item-${group.itemId}`"
        class="space-y-2"
      >
        <h3
          :id="`documents-item-${group.itemId}`"
          class="text-muted text-sm font-semibold"
        >
          <AgendaItemNumber
            v-if="group.number || group.unlisted"
            :number="group.number"
          />
          {{ group.title }}
        </h3>
        <AgendaDocumentRow
          v-for="document in group.documents"
          :key="document.id"
          :document="document"
          :to="documentPath(document)"
          :edit-to="documentEditPath(document)"
        >
          <template v-if="canEditRecords" #actions>
            <UTooltip :text="t('documents.editRecord')">
              <UButton
                color="neutral"
                variant="ghost"
                size="xs"
                icon="i-lucide-file-cog"
                :aria-label="
                  t('documents.editRecordOf', { title: document.title })
                "
                @click="openRecord(document)"
              />
            </UTooltip>
          </template>
        </AgendaDocumentRow>
      </section>
    </div>

    <DocumentRecordDialog
      v-if="canEditRecords"
      v-model:open="recordOpen"
      :document-id="recordDocument?.id ?? null"
      :title="recordDocument?.title ?? null"
      @saved="refresh()"
    />
  </div>
</template>
