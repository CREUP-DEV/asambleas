<script setup lang="ts">
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type { AgendaItemDto, DocumentSummaryDto } from "~~/shared/types/api";
import { agendaItemPath } from "~/composables/document/agendaReturn";
import { memberSubmissionKinds } from "~/composables/document/documentKinds";
import { isDocumentPresenter } from "~/composables/document/documentPresenters";
import { useAddDocument } from "~/composables/document/useAddDocument";
import { useAgendaItemBreadcrumb } from "~/composables/shell/useBreadcrumbs";

/**
 * The page of one agenda item or sub-item, keyed by the item's id (its
 * number changes when the agenda is reordered). It reads the agenda the hub
 * pages share (useAssemblyAgenda) and picks its part: nothing else is
 * fetched.
 *
 * Top to bottom: number, title and description; the manage bar
 * (AgendaItemManageBar: edit, add a sub-item, add documents, delete), which
 * shows itself to managers only; the item's documents with everything the
 * agenda leaves out (presenters, amendment window, where a draft stands);
 * "Presentar documento" for members where the item takes their documents;
 * its sub-items as links with their totals; and "Anterior" / "Siguiente",
 * which walk the agenda in reading order across levels.
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

const itemId = computed(() => {
  const param = route.params.item;
  return typeof param === "string" ? param : "";
});

const items = computed<AgendaItemDto[]>(() => agenda.value?.items ?? []);
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
const numbered = (number: string, title: string) => `${number}. ${title}`;

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

// Breadcrumbs: the items above this one, then this one.
const itemPath = (id: string) => agendaItemPath(sectionPath(), id);
useAgendaItemBreadcrumb(() =>
  node.value
    ? agendaNodePath(tree.value, node.value.item.id).map((step) => ({
        id: step.item.id,
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
      <header class="space-y-2">
        <h2
          class="text-highlighted text-xl font-semibold break-words sm:text-2xl"
          data-testid="agenda-item-title"
        >
          <span class="text-primary me-2 tabular-nums">{{ node.number }}.</span
          >{{ item.title }}
        </h2>
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

        <ul v-if="documents.length > 0" class="space-y-2">
          <li v-for="document in documents" :key="document.id">
            <AgendaDocumentRow
              :document="document"
              :to="documentPath(document)"
              :edit-to="documentEditPath(document)"
            />
          </li>
        </ul>
        <p v-else class="text-muted text-sm">
          {{
            node.children.length > 0
              ? t("agenda.item.noOwnDocuments")
              : t("agenda.item.noDocuments")
          }}
        </p>
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
                <span class="text-primary me-1.5 tabular-nums"
                  >{{ child.number }}.</span
                >{{ child.item.title }}
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
              </span>
            </NuxtLink>
          </li>
        </ol>
      </section>

      <!-- Previous and next item, in reading order -->
      <nav
        v-if="neighbours.previous || neighbours.next"
        class="border-default grid gap-3 border-t pt-4 sm:grid-cols-2"
        :aria-label="t('agenda.item.neighbours')"
        data-testid="agenda-item-neighbours"
      >
        <NuxtLink
          v-if="neighbours.previous"
          :to="itemPath(neighbours.previous.item.id)"
          rel="prev"
          class="border-default hover:bg-elevated/50 focus-visible:outline-primary flex min-h-14 items-center gap-3 rounded-lg border px-3 py-3 focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <UIcon
            name="i-lucide-arrow-left"
            class="text-muted size-5 shrink-0"
            aria-hidden="true"
          />
          <span class="min-w-0">
            <span class="text-muted block text-xs">
              {{ t("agenda.item.previous") }}
            </span>
            <span
              class="text-highlighted block text-sm font-medium break-words"
            >
              {{
                numbered(
                  neighbours.previous.number,
                  neighbours.previous.item.title,
                )
              }}
            </span>
          </span>
        </NuxtLink>
        <NuxtLink
          v-if="neighbours.next"
          :to="itemPath(neighbours.next.item.id)"
          rel="next"
          class="border-default hover:bg-elevated/50 focus-visible:outline-primary flex min-h-14 items-center justify-end gap-3 rounded-lg border px-3 py-3 text-end focus-visible:outline-2 focus-visible:outline-offset-2 sm:col-start-2"
        >
          <span class="min-w-0">
            <span class="text-muted block text-xs">
              {{ t("agenda.item.next") }}
            </span>
            <span
              class="text-highlighted block text-sm font-medium break-words"
            >
              {{ numbered(neighbours.next.number, neighbours.next.item.title) }}
            </span>
          </span>
          <UIcon
            name="i-lucide-arrow-right"
            class="text-muted size-5 shrink-0"
            aria-hidden="true"
          />
        </NuxtLink>
      </nav>

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
