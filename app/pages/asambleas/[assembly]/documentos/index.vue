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
 * have amendments it has not read.
 */

const { t } = useI18n();
const me = useMe();
const now = useAppNow();
const current = useCurrentAssembly();
const { assembly, sectionPath } = current;

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

function resetFilters() {
  search.value = "";
  status.value = "all";
  kind.value = "all";
  onlyMine.value = false;
  onlyLeft.value = false;
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
      <UButton
        color="neutral"
        variant="outline"
        icon="i-lucide-list-tree"
        :label="t('documents.byAgenda')"
        :to="sectionPath('orden-del-dia')"
      />
    </div>

    <div
      v-if="total > 0"
      class="flex flex-col gap-2 sm:flex-row sm:items-center"
      role="search"
    >
      <UInput
        v-model="search"
        icon="i-lucide-search"
        :placeholder="t('documents.searchPlaceholder')"
        :aria-label="t('documents.searchLabel')"
        class="sm:max-w-sm sm:flex-1"
      />
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
        :label="
          t('documents.onlyMine', { member: me.member.value?.acronym ?? '' })
        "
      />
      <USwitch
        v-if="leftCount > 0 || onlyLeft"
        v-model="onlyLeft"
        size="sm"
        :label="t('readMarks.onlyLeft', { count: leftCount })"
        data-testid="documents-only-left"
      />
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
        />
      </section>
    </div>
  </div>
</template>
