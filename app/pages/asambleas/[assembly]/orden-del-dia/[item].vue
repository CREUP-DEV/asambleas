<script setup lang="ts">
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type { AgendaItemDto, DocumentSummaryDto } from "~~/shared/types/api";
import { isDocumentLeft } from "~~/shared/utils/readMarks";
import { agendaItemPath } from "~/composables/document/agendaReturn";
import { memberSubmissionKinds } from "~/composables/document/documentKinds";
import { isDocumentPresenter } from "~/composables/document/documentPresenters";
import { useAddDocument } from "~/composables/document/useAddDocument";
import { useAgendaItemBreadcrumb } from "~/composables/shell/useBreadcrumbs";

/**
 * The page of one agenda item or sub-item, keyed by the item's slug
 * (AgendaItemDto.slug; its number changes when the agenda is reordered). An
 * older link by id still opens it, and the address moves to the slug, also
 * when the item is renamed. It reads the agenda the hub
 * pages share (useAssemblyAgenda) and picks its part: nothing else is
 * fetched.
 *
 * Top to bottom: the reading bar of a document's page (DocumentReadBar),
 * for the document its reader has on show; number and title, with "Punto anterior" / "Punto
 * siguiente" beside it, which walk the agenda in reading order across
 * levels; the description; the manage bar
 * (AgendaItemManageBar: edit, add a sub-item, add documents, delete), which
 * shows itself to managers only; the item's published documents in a
 * reader (AgendaItemReader): one on show at a time, in place, with tabs to
 * move between them; the ones that are not published (a draft of the
 * user's member, what managers see before publication) as rows under it,
 * with where each stands;
 * "Presentar documento" for members where the item takes their documents;
 * and its sub-items as links with their totals.
 *
 * An id that is not in the agenda is a 404. An item that goes away while
 * the page is open (deleted here or elsewhere) leaves a note and the way to
 * the agenda instead of an error page.
 */

const { t } = useI18n();
const route = useRoute();
const me = useMe();
const { assembly, apiBase, sectionPath } = useCurrentAssembly();

const { data: agenda, pending, error, refresh } = await useAssemblyAgenda();

const param = computed(() => {
  const value = route.params.item;
  return typeof value === "string" ? value : "";
});

const items = computed<AgendaItemDto[]>(() => agenda.value?.items ?? []);
/** The item in the address, by its slug or, from older links, its id. */
const itemId = computed(
  () =>
    (
      items.value.find((entry) => entry.slug === param.value) ??
      items.value.find((entry) => entry.id === param.value)
    )?.id ?? param.value,
);
const tree = computed(() => buildAgendaTree(items.value));
const node = computed(() => findAgendaNode(tree.value, itemId.value));

if (agenda.value && !node.value) {
  throw createError({
    statusCode: 404,
    data: { messageKey: "agenda.item.notFound" },
    fatal: true,
  });
}

const item = computed(() => node.value?.item ?? null);
/** "3. Resoluciones"; an item without a number says it is not published. */
const numbered = (number: string | null, title: string) =>
  numberedAgendaTitle(number, title, t("agenda.unlisted.inText"));

useHead({
  title: () =>
    [
      node.value
        ? numbered(node.value.number, node.value.item.title)
        : t("agenda.title"),
      assembly.value?.label,
    ]
      .filter(Boolean)
      .join(" · "),
});

/** The page of an item of this agenda, by its id. */
const itemPath = (id: string) =>
  agendaItemPath(sectionPath(), {
    slug: items.value.find((entry) => entry.id === id)?.slug ?? id,
  });

// The address follows the slug: an older link by id, or a renamed item.
watch(
  () => item.value?.slug,
  (slug) => {
    if (import.meta.client && slug && slug !== param.value) {
      void navigateTo(
        {
          path: itemPath(item.value!.id),
          query: route.query,
          hash: route.hash,
        },
        { replace: true },
      );
    }
  },
  { immediate: true },
);

// Breadcrumbs: the items above this one, then this one, keyed by the slug
// the address carries.
useAgendaItemBreadcrumb(() =>
  node.value
    ? agendaNodePath(tree.value, node.value.item.id).map((step) => ({
        id: step.item.slug,
        label: numbered(step.number, step.item.title),
      }))
    : null,
);

// Documents ---------------------------------------------------------------------

const documents = computed<DocumentSummaryDto[]>(() =>
  (agenda.value?.documents ?? []).filter(
    (document) => document.agendaItemId === itemId.value,
  ),
);

const canCreateDocument = computed(() =>
  me.can(PERMISSION_KEYS.DOCUMENT_MANAGE),
);

/**
 * What the reader shows: the published ones. A draft is never previewed;
 * it keeps its row, with its next step.
 */
const readable = computed(() =>
  documents.value.filter((document) => document.status === "published"),
);
const unpublished = computed(() =>
  documents.value.filter((document) => document.status !== "published"),
);
/** Every published document, as the agenda reads: what the reader walks. */
const readingOrder = computed(() =>
  documentsInAgendaOrder(
    tree.value,
    (agenda.value?.documents ?? []).filter(
      (document) => document.status === "published",
    ),
  ),
);

/** The document the reader has on show (`?doc=<slug>`, else the first). */
const readerDocument = computed(
  () =>
    itemReaderPosition(
      readingOrder.value,
      itemId.value,
      typeof route.query[ITEM_READER_QUERY] === "string"
        ? (route.query[ITEM_READER_QUERY] as string)
        : null,
    ).current,
);
/** A document in the reader of its item's page. */
function readerPath(document: DocumentSummaryDto) {
  return {
    path: itemPath(document.agendaItemId),
    query: { [ITEM_READER_QUERY]: document.slug },
  };
}

function documentPath(document: DocumentSummaryDto): string {
  return sectionPath(`documentos/${encodeURIComponent(document.slug)}`);
}

/**
 * The editor of a draft the user's member presents, as on the agenda:
 * managers open documents in the workspace like everyone else.
 */
function documentEditPath(document: DocumentSummaryDto): string | null {
  if (
    document.status !== "draft" ||
    !isDocumentPresenter(document, me.member.value?.id) ||
    canCreateDocument.value
  ) {
    return null;
  }
  return `${documentPath(document)}/editar`;
}

// Members presenting here --------------------------------------------------------

const addDocument = useAddDocument(agenda);

// The shared clock, so the button goes away with the deadline.
const now = useAppNow();
const documentsClosed = computed(() => {
  const close = assembly.value?.milestones.find(
    (milestone) => milestone.key === "documents_close",
  );
  return Boolean(close && new Date(close.at).getTime() <= now.value);
});

/**
 * A member acting for a member, where the item takes a kind that member may
 * present (a sectorial, never an internal motion), as on the agenda list.
 */
const memberMaySubmitHere = computed(
  () =>
    Boolean(
      item.value &&
      memberSubmissionKinds(item.value, me.member.value?.kind).length > 0,
    ) &&
    Boolean(assembly.value?.can.createDocuments) &&
    Boolean(me.member.value) &&
    !canCreateDocument.value,
);
const submitBlockedReason = computed<string | null>(() => {
  if (!memberMaySubmitHere.value) return null;
  if (assembly.value?.status === "closed") {
    return t("agenda.submissionsClosedAssembly");
  }
  if (documentsClosed.value) return t("agenda.submissionsDeadlinePassed");
  return null;
});
const showMemberSubmit = computed(
  () => memberMaySubmitHere.value && submitBlockedReason.value === null,
);

/** "Los miembros presentan aquí: resoluciones, mociones internas." */
const submissionsNote = computed(() => {
  const value = item.value;
  if (!value?.acceptsSubmissions) return null;
  if (value.submissionKinds.length === 0) {
    return t("agenda.item.submissions.any");
  }
  return t("agenda.item.submissions.kinds", {
    kinds: value.submissionKinds
      .map((kind) => t(`agenda.documentKinds.${kind}`))
      .join(", "),
  });
});

// Sub-items and neighbours -------------------------------------------------------

const totals = computed(() =>
  agendaSubtreeTotals(items.value, agenda.value?.documents ?? []),
);
const totalsFor = (id: string) =>
  totals.value.get(id) ?? { documents: 0, amendments: 0 };

/** Documents and amendments left to read under every item. */
const marks = useReadMarks();
const leftByItem = computed(() =>
  agendaSubtreeLeft(tree.value, agenda.value?.documents ?? [], (id) => {
    const mark = marks.document(id);
    return (
      (mark && isDocumentLeft(mark) ? 1 : 0) +
      (marks.index.value.amendmentsLeft.get(id) ?? 0)
    );
  }),
);
const leftFor = (id: string) => leftByItem.value.get(id) ?? 0;

const neighbours = computed(() => agendaNeighbours(tree.value, itemId.value));

// The item goes away ------------------------------------------------------------

/** Where to go once this item is gone: the item above, or the agenda. */
const parentId = ref<string | null>(node.value?.parentId ?? null);
watch(node, (value) => {
  if (value) parentId.value = value.parentId;
});

async function onDeleted() {
  await navigateTo(
    parentId.value ? itemPath(parentId.value) : sectionPath("orden-del-dia"),
    { replace: true },
  );
}
</script>

<template>
  <div v-if="assembly" class="space-y-6">
    <!-- Loading -->
    <div v-if="pending && !agenda" class="space-y-3" role="status">
      <span class="sr-only">{{ t("agenda.loading") }}</span>
      <USkeleton
        v-for="index in 3"
        :key="index"
        aria-hidden="true"
        class="h-20 w-full"
      />
    </div>

    <!-- Error -->
    <UAlert
      v-else-if="error && !agenda"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :title="t('agenda.loadError')"
      :actions="[
        {
          label: t('agenda.retry'),
          icon: 'i-lucide-refresh-ccw',
          color: 'neutral',
          variant: 'outline',
          onClick: () => {
            void refresh();
          },
        },
      ]"
      role="alert"
    />

    <!-- Deleted while the page was open -->
    <CommonEmptyState
      v-else-if="!node || !item"
      icon="i-lucide-list-x"
      :title="t('agenda.item.gone.title')"
      variant="outline"
    >
      <template #action>
        <UButton
          icon="i-lucide-list-tree"
          :label="t('agenda.item.gone.back')"
          :to="sectionPath('orden-del-dia')"
        />
      </template>
    </CommonEmptyState>

    <template v-else>
      <!-- Reading the documents one after another, as on a document's page:
           for the one the reader below has on show, and opening the others
           in the reader of their item. -->
      <DocumentReadBar
        v-if="readerDocument"
        :document="readerDocument"
        :to="readerPath"
      />

      <header class="space-y-2">
        <div
          class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
        >
          <h2
            class="text-highlighted min-w-0 text-xl font-semibold break-words sm:text-2xl"
            data-testid="agenda-item-title"
          >
            <AgendaItemNumber
              :number="node.number"
              class="text-primary me-2"
            />{{ item.title }}
          </h2>
          <!-- The items before and after this one, in reading order: always
               here, whatever the item holds -->
          <nav
            v-if="neighbours.previous || neighbours.next"
            class="flex shrink-0 items-center gap-1"
            :aria-label="t('agenda.item.neighbours')"
            data-testid="agenda-item-neighbours"
          >
            <UButton
              icon="i-lucide-arrow-left"
              color="neutral"
              variant="ghost"
              size="sm"
              rel="prev"
              :to="
                neighbours.previous
                  ? itemPath(neighbours.previous.item.id)
                  : undefined
              "
              :disabled="!neighbours.previous"
              :label="t('agenda.item.previousItem')"
              :title="
                neighbours.previous
                  ? numbered(
                      neighbours.previous.number,
                      neighbours.previous.item.title,
                    )
                  : undefined
              "
            />
            <UButton
              trailing-icon="i-lucide-arrow-right"
              color="neutral"
              variant="ghost"
              size="sm"
              rel="next"
              :to="
                neighbours.next ? itemPath(neighbours.next.item.id) : undefined
              "
              :disabled="!neighbours.next"
              :label="t('agenda.item.nextItem')"
              :title="
                neighbours.next
                  ? numbered(neighbours.next.number, neighbours.next.item.title)
                  : undefined
              "
            />
          </nav>
        </div>
        <p
          v-if="item.description"
          class="text-default max-w-prose text-sm whitespace-pre-line sm:text-base"
        >
          {{ item.description }}
        </p>
        <p
          v-if="submissionsNote"
          class="text-muted flex items-start gap-2 text-sm"
          data-testid="agenda-item-submissions"
        >
          <UIcon
            name="i-lucide-file-up"
            class="mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          <span>{{ submissionsNote }}</span>
        </p>
      </header>

      <!-- Edit, add a sub-item, add documents, delete: managers only -->
      <AgendaItemManageBar :item="node" @deleted="onDeleted" />

      <!-- Documents -->
      <section class="space-y-3" aria-labelledby="agenda-item-documents-title">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h3
            id="agenda-item-documents-title"
            class="text-highlighted text-base font-semibold sm:text-lg"
          >
            {{ t("agenda.item.documents") }}
          </h3>
          <UButton
            v-if="showMemberSubmit"
            icon="i-lucide-file-up"
            size="lg"
            class="w-full justify-center sm:w-auto"
            :label="t('agenda.actions.submitDocument')"
            data-testid="agenda-item-submit"
            @click="addDocument.openFor(item.id, 'member')"
          />
        </div>

        <UAlert
          v-if="submitBlockedReason"
          color="neutral"
          variant="subtle"
          icon="i-lucide-lock"
          :title="submitBlockedReason"
        />

        <AgendaItemReader
          v-if="readable.length > 0"
          :item-id="item.id"
          :ordered="readingOrder"
          :item-path="itemPath"
          :document-path="documentPath"
        />

        <!-- Not published: never previewed, each with where it stands -->
        <div v-if="unpublished.length > 0" class="space-y-2">
          <h4
            v-if="readable.length > 0"
            class="text-muted text-sm font-medium"
            data-testid="agenda-item-unpublished"
          >
            {{ t("agenda.item.unpublished") }}
          </h4>
          <ul class="space-y-2">
            <li v-for="document in unpublished" :key="document.id">
              <AgendaDocumentRow
                :document="document"
                :to="documentPath(document)"
                :edit-to="documentEditPath(document)"
              />
            </li>
          </ul>
        </div>
        <template v-if="documents.length === 0">
          <!-- Its sub-items follow: one line is enough -->
          <p v-if="node.children.length > 0" class="text-muted text-sm">
            {{ t("agenda.item.noOwnDocuments") }}
          </p>
          <!-- Nothing else on the page: say so in the open space -->
          <div
            v-else
            class="border-default flex flex-col items-center gap-4 rounded-lg border border-dashed px-4 py-16 text-center sm:py-24"
            role="status"
            data-testid="agenda-item-empty"
          >
            <UIcon
              name="i-lucide-file-x"
              class="text-dimmed size-16 sm:size-24"
              aria-hidden="true"
            />
            <p class="text-muted text-base">
              {{ t("agenda.item.noDocuments") }}
            </p>
          </div>
        </template>
      </section>

      <!-- Sub-items -->
      <section
        v-if="node.children.length > 0"
        class="space-y-3"
        aria-labelledby="agenda-item-children-title"
      >
        <h3
          id="agenda-item-children-title"
          class="text-highlighted text-base font-semibold sm:text-lg"
        >
          {{ t("agenda.item.subItems") }}
        </h3>
        <ol
          class="divide-default border-default divide-y rounded-lg border"
          data-testid="agenda-item-children"
        >
          <li v-for="child in node.children" :key="child.item.id">
            <NuxtLink
              :to="itemPath(child.item.id)"
              class="hover:bg-elevated/50 focus-visible:outline-primary flex min-h-12 flex-col gap-1 px-3 py-3 focus-visible:outline-2 focus-visible:-outline-offset-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:px-4"
            >
              <span class="text-highlighted min-w-0 font-medium break-words">
                <AgendaItemNumber
                  :number="child.number"
                  class="text-primary me-1.5"
                />{{ child.item.title }}
              </span>
              <span
                v-if="totalsFor(child.item.id).documents > 0"
                class="text-muted flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums"
              >
                <span class="inline-flex items-center gap-1">
                  <UIcon
                    name="i-lucide-file"
                    class="size-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  {{
                    t(
                      "assembly.overview.documentCount",
                      { count: totalsFor(child.item.id).documents },
                      totalsFor(child.item.id).documents,
                    )
                  }}
                </span>
                <span class="inline-flex items-center gap-1">
                  <UIcon
                    name="i-lucide-message-square-diff"
                    class="size-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  {{
                    t(
                      "assembly.overview.amendmentCount",
                      { count: totalsFor(child.item.id).amendments },
                      totalsFor(child.item.id).amendments,
                    )
                  }}
                </span>
                <span
                  v-if="leftFor(child.item.id) > 0"
                  class="text-default inline-flex items-center gap-1.5"
                  data-testid="agenda-item-left"
                >
                  <span
                    class="bg-primary size-2 shrink-0 rounded-full"
                    aria-hidden="true"
                  />
                  {{
                    t(
                      "readMarks.itemLeft",
                      { count: leftFor(child.item.id) },
                      leftFor(child.item.id),
                    )
                  }}
                </span>
              </span>
            </NuxtLink>
          </li>
        </ol>
      </section>

      <AgendaNewDocumentModal
        v-model:open="addDocument.open.value"
        :api-base="apiBase"
        :base-path="sectionPath()"
        :items="addDocument.items.value"
        :item-id="addDocument.itemId.value"
        :mode="addDocument.mode.value"
        origin="agenda"
        @created="refresh()"
      />
    </template>
  </div>
</template>
