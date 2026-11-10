<script setup lang="ts">
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type {
  AgendaDto,
  AgendaItemDto,
  DocumentSummaryDto,
} from "~~/shared/types/api";
import {
  AGENDA_TREE_CONTEXT,
  agendaItemAnchor,
  type AgendaTreeContext,
} from "~/components/agenda/ItemNode.vue";
import { isDocumentPresenter } from "~/composables/document/documentPresenters";
import { ORGANIZE_QUERY } from "~/composables/document/agendaReturn";
import { useAddDocument } from "~/composables/document/useAddDocument";
import type {
  AgendaFoldState,
  AgendaMove,
  AgendaRootChangeRunner,
  AgendaTreeNode,
} from "~/utils/agendaTree";

/**
 * Agenda (orden del día): the item tree with its documents. By default it is
 * a clean list: numbered items, their documents and, for members,
 * "Presentar documento" under the items that accept submissions. Items with
 * sub-items fold: by default the sub-items of a root item show and theirs
 * are hidden; what the reader opens or closes is remembered per assembly in
 * the browser, and "Desplegar todo" / "Plegar todo" do it at once. Managers
 * mark the agenda as final here (AgendaFinalAction); once final, a change
 * to the root items asks for a confirmation first. Managers
 * switch to "Organizar orden del día" to add, edit, move (buttons, keyboard
 * accessible), switch submissions, delete items and add documents.
 * `?organizar=1` opens it organized and a `#agenda-item-…` hash focuses that
 * item: the editor of a document added here comes back that way, so the
 * Secretaría adds the next one without looking for the item again.
 * While documents can be presented, "Añadir documento" ("Presentar
 * documento" for members) at the top opens the same modal with the item to
 * choose (useAddDocument), and `?nuevo=<item>` opens it on the next item.
 */

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const toast = useToast();
const api = useApi();
const me = useMe();
const current = useCurrentAssembly();
const { assembly, apiBase, sectionPath } = current;

useHead({
  title: () =>
    [t("agenda.title"), assembly.value?.label].filter(Boolean).join(" · "),
});

const { data: agenda, pending, error, refresh } = await useAssemblyAgenda();

const items = computed<AgendaItemDto[]>(() => agenda.value?.items ?? []);
const tree = computed(() => buildAgendaTree(items.value));
const numbers = computed(
  () =>
    new Map(
      flattenAgendaTree(tree.value).map((node) => [node.item.id, node.number]),
    ),
);

const documentsByItem = computed(() => {
  const map = new Map<string, DocumentSummaryDto[]>();
  for (const document of agenda.value?.documents ?? []) {
    const list = map.get(document.agendaItemId);
    if (list) list.push(document);
    else map.set(document.agendaItemId, [document]);
  }
  return map;
});

// Capabilities -----------------------------------------------------------------

const manage = computed(() => Boolean(assembly.value?.can.manage));
const agendaFinal = computed(() => Boolean(assembly.value?.agendaFinalizedAt));

interface MoreItem {
  label: string;
  icon: string;
  to?: string;
  onSelect?: () => void;
}
const finalAction = useTemplateRef<{ ask: (final: boolean) => void }>(
  "finalAction",
);
/**
 * What the header keeps out of its first plane: the convocation and, for
 * managers, marking the agenda as final or reopening it. An empty agenda is
 * not marked as final, but a final one that lost its items can be reopened.
 */
const moreItems = computed<MoreItem[]>(() => {
  const list: MoreItem[] = [];
  if (!organizing.value) {
    list.push({
      label: t("agenda.seeConvocation"),
      icon: "i-lucide-scroll-text",
      to: sectionPath("convocatoria"),
    });
  }
  if (manage.value && (tree.value.length > 0 || agendaFinal.value)) {
    list.push(
      agendaFinal.value
        ? {
            label: t("agenda.finalAgenda.reopen"),
            icon: "i-lucide-lock-open",
            onSelect: () => finalAction.value?.ask(false),
          }
        : {
            label: t("agenda.finalAgenda.mark"),
            icon: "i-lucide-lock",
            onSelect: () => finalAction.value?.ask(true),
          },
    );
  }
  return list;
});
/** A lone entry as a button of its own. */
function moreButton(item: MoreItem) {
  return {
    label: item.label,
    icon: item.icon,
    to: item.to,
    onClick: item.onSelect,
  };
}
const canCreateDocument = computed(() =>
  me.can(PERMISSION_KEYS.DOCUMENT_MANAGE),
);

// The shared clock, so "Presentar documento" closes with the deadline even
// in a tab that stays open for days.
const now = useAppNow();
const documentsClosed = computed(() => {
  const close = assembly.value?.milestones.find(
    (milestone) => milestone.key === "documents_close",
  );
  return Boolean(close && new Date(close.at).getTime() <= now.value);
});

const submitBlockedReason = computed<string | null>(() => {
  const value = assembly.value;
  if (!value?.can.createDocuments || !me.member.value) return null;
  if (value.status === "closed") return t("agenda.submissionsClosedAssembly");
  if (documentsClosed.value) return t("agenda.submissionsDeadlinePassed");
  return null;
});
const canSubmitDocument = computed(
  () =>
    Boolean(assembly.value?.can.createDocuments) &&
    Boolean(me.member.value) &&
    submitBlockedReason.value === null,
);
/**
 * Said once above the agenda (not on every item) when a member could
 * present documents here but no longer can.
 */
const showSubmitBlocked = computed(
  () =>
    submitBlockedReason.value !== null &&
    !canCreateDocument.value &&
    items.value.some((item) => item.acceptsSubmissions),
);

// Organize mode -----------------------------------------------------------------

/** Who gets the organize mode: item managers and document managers. */
const canOrganize = computed(() => manage.value || canCreateDocument.value);
const organizing = ref(
  canOrganize.value && route.query[ORGANIZE_QUERY] === "1",
);

watch(canOrganize, (allowed) => {
  if (!allowed) organizing.value = false;
});

// The address keeps the mode, so going back to this page restores it.
watch(organizing, (value) => {
  const query = Object.fromEntries(
    Object.entries(route.query).filter(([key]) => key !== ORGANIZE_QUERY),
  );
  if (value) query[ORGANIZE_QUERY] = "1";
  void router.replace({ query });
});

function toggleOrganizing() {
  organizing.value = !organizing.value;
  announce(
    organizing.value
      ? t("agenda.organize.enabled")
      : t("agenda.organize.disabled"),
  );
}

/**
 * Documents that keep an item from being deleted (server rule): presented
 * or public ones, and any document that was ever published, since it keeps
 * its reference, base text and amendments even after a withdrawal.
 */
const PROTECTED_STATUSES = new Set(["submitted", "published", "postponed"]);

function canDelete(itemId: string): boolean {
  const item = items.value.find((candidate) => candidate.id === itemId);
  if (!item) return false;
  for (const id of agendaSubtreeIds(items.value, itemId)) {
    if (
      (documentsByItem.value.get(id) ?? []).some(
        (document) =>
          PROTECTED_STATUSES.has(document.status) ||
          document.publishedAt !== null,
      )
    ) {
      return false;
    }
  }
  return true;
}

// Folding ---------------------------------------------------------------------

/**
 * What the reader folded or unfolded, per assembly, in the browser. The
 * server renders the default state and the stored one is read on mount, so
 * hydration always matches.
 */
const storedFold = useLocalStorage<AgendaFoldState>(
  `agenda-fold-${assembly.value?.id ?? String(route.params.assembly ?? "")}`,
  { open: [], closed: [] },
  { initOnMounted: true },
);
const foldState = computed(() => readAgendaFold(storedFold.value));
const collapsedIds = computed(() =>
  collapsedAgendaIds(items.value, foldState.value),
);
const foldableCount = computed(() => agendaFoldableIds(items.value).length);

function toggleFold(itemId: string) {
  storedFold.value = toggleAgendaFold(items.value, foldState.value, itemId);
}

/** Unfolds what hides an item, before focusing or scrolling to it. */
function revealItem(itemId: string) {
  const next = expandAgendaAncestors(items.value, foldState.value, itemId);
  if (next !== foldState.value) storedFold.value = next;
}

function expandAll() {
  storedFold.value = expandAllAgenda(items.value);
  announce(t("agenda.fold.expandedAll"));
}

function collapseAll() {
  storedFold.value = collapseAllAgenda(items.value);
  announce(t("agenda.fold.collapsedAll"));
}

// Final agenda: confirm a change to the root items --------------------------------

const finalConfirmOpen = ref(false);
let answerFinalConfirm: ((confirmed: boolean) => void) | null = null;

/** Asks "¿Cambiarlo igualmente?" and resolves with the answer. */
function askFinalChange(): Promise<boolean> {
  answerFinalConfirm?.(false);
  return new Promise((resolve) => {
    answerFinalConfirm = resolve;
    finalConfirmOpen.value = true;
  });
}

function settleFinalConfirm(confirmed: boolean) {
  const answer = answerFinalConfirm;
  answerFinalConfirm = null;
  finalConfirmOpen.value = false;
  answer?.(confirmed);
}

// Closing the dialog any other way (Escape, outside click) is a no.
watch(finalConfirmOpen, (isOpen) => {
  if (!isOpen) settleFinalConfirm(false);
});

/**
 * Runs a request that may change the root items. With a final agenda it
 * asks first; if the server still answers 409 `agenda_final` (the agenda
 * became final meanwhile), it asks then and sends the request again.
 */
const runRootChange: AgendaRootChangeRunner = async (changesRoots, run) => {
  let confirmed = false;
  if (changesRoots && agendaFinal.value) {
    if (!(await askFinalChange())) return null;
    confirmed = true;
  }
  try {
    return await run(confirmed);
  } catch (failure) {
    if (confirmed || !isAgendaFinalConflict(failure)) throw failure;
    void current.refresh();
    if (!(await askFinalChange())) return null;
    return await run(true);
  }
};

// Announcements and focus ----------------------------------------------------

const announcement = ref("");
function announce(message: string) {
  // Re-announce identical messages (e.g. two moves in a row).
  announcement.value = "";
  void nextTick(() => {
    announcement.value = message;
  });
}

async function focusItem(id: string, move?: AgendaMove) {
  revealItem(id);
  await nextTick();
  if (!import.meta.client) return;
  const buttons = Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      `[data-agenda-move^="${CSS.escape(id)}:"]`,
    ),
  );
  const preferred = move
    ? buttons.find(
        (button) =>
          button.dataset.agendaMove === `${id}:${move}` && !button.disabled,
      )
    : undefined;
  const target =
    preferred ??
    buttons.find((button) => !button.disabled) ??
    document.getElementById(agendaItemAnchor(id));
  target?.focus();
}

// A link to an item (back from a document added here, or from the overview):
// unfold what hides it, then focus it. Registered after useLocalStorage, so
// the stored fold state is already read.
onMounted(async () => {
  const prefix = `#${agendaItemAnchor("")}`;
  if (!route.hash.startsWith(prefix)) return;
  const id = decodeURIComponent(route.hash.slice(prefix.length));
  revealItem(id);
  await nextTick();
  const heading = document.getElementById(agendaItemAnchor(id));
  heading?.scrollIntoView({ block: "start" });
  heading?.focus({ preventScroll: true });
});

// Moves -------------------------------------------------------------------------

const busyId = ref<string | null>(null);

function canMove(itemId: string, move: AgendaMove): boolean {
  return canMoveAgendaItem(items.value, itemId, move);
}

async function moveItem(itemId: string, move: AgendaMove) {
  // Buttons stay enabled while busy (disabling them would drop focus).
  if (busyId.value || !agenda.value) return;
  const plan = planAgendaMove(items.value, itemId, move);
  if (!plan) return;

  // A final agenda: ask before the root items change, and before the
  // optimistic update shows the move.
  let confirmFinal = false;
  if (agendaFinal.value && reorderChangesRoots(items.value, plan)) {
    busyId.value = itemId;
    const confirmed = await askFinalChange();
    busyId.value = null;
    if (!confirmed || !agenda.value) {
      void focusItem(itemId, move);
      return;
    }
    confirmFinal = true;
  }

  busyId.value = itemId;
  const previous = agenda.value;
  agenda.value = {
    ...previous,
    items: applyAgendaReorder(previous.items, plan),
  };
  const title = previous.items.find((item) => item.id === itemId)?.title ?? "";
  void focusItem(itemId, move);

  try {
    const updated = await api.send<AgendaDto>(
      `${apiBase.value}/agenda/reorder`,
      {
        method: "PUT",
        body: { items: plan, ...(confirmFinal ? { confirmFinal: true } : {}) },
      },
    );
    agenda.value = updated;
    // An item without a number (not in the agenda for everyone yet) says so.
    const number = numbers.value.get(itemId);
    announce(
      number
        ? t("agenda.moved", { title, number })
        : t("agenda.unlisted.moved", { title }),
    );
    if (import.meta.client && document.activeElement === document.body) {
      void focusItem(itemId, move);
    }
  } catch (failure) {
    agenda.value = previous;
    if (!confirmFinal && isAgendaFinalConflict(failure)) {
      // The agenda became final meanwhile: load that, then the same move
      // asks for the confirmation.
      await Promise.all([current.refresh(), refresh()]);
      busyId.value = null;
      if (agendaFinal.value) {
        await moveItem(itemId, move);
        return;
      }
      // The assembly could not be read again: say the move did not happen.
      api.notifyError(failure, "agenda.moveError");
      void focusItem(itemId, move);
      return;
    }
    api.notifyError(failure, "agenda.moveError");
    await refresh();
    void focusItem(itemId, move);
  } finally {
    busyId.value = null;
  }
}

// Submissions switch -------------------------------------------------------------

async function toggleSubmissions(item: AgendaItemDto, value: boolean) {
  if (busyId.value || !agenda.value) return;
  busyId.value = item.id;
  const previous = agenda.value;
  agenda.value = {
    ...previous,
    items: previous.items.map((candidate) =>
      candidate.id === item.id
        ? { ...candidate, acceptsSubmissions: value }
        : candidate,
    ),
  };
  try {
    const saved = await api.send<AgendaItemDto>(
      `${apiBase.value}/agenda/${item.id}`,
      {
        method: "PUT",
        body: {
          title: item.title,
          description: item.description,
          acceptsSubmissions: value,
          updatedAt: item.updatedAt,
        },
      },
    );
    if (agenda.value) {
      agenda.value = {
        ...agenda.value,
        items: agenda.value.items.map((candidate) =>
          candidate.id === saved.id ? saved : candidate,
        ),
      };
    }
    announce(
      value
        ? t("agenda.submissionsOpened", { title: item.title })
        : t("agenda.submissionsClosed", { title: item.title }),
    );
  } catch (failure) {
    agenda.value = previous;
    api.notifyError(failure, "agenda.saveError");
    if (api.isConflict(failure)) await refresh();
  } finally {
    busyId.value = null;
  }
}

// Item form ---------------------------------------------------------------------

const formOpen = ref(false);
const formItem = ref<AgendaItemDto | null>(null);
const formParent = ref<{
  id: string;
  title: string;
  number: string | null;
} | null>(null);

function openCreate(parent: AgendaTreeNode<AgendaItemDto> | null) {
  // Adding items is organizing: the first item (from the empty state) keeps
  // the controls on, ready for the next one.
  organizing.value = true;
  formItem.value = null;
  formParent.value = parent
    ? { id: parent.item.id, title: parent.item.title, number: parent.number }
    : null;
  formOpen.value = true;
}

function openEdit(item: AgendaItemDto) {
  formItem.value = item;
  formParent.value = null;
  formOpen.value = true;
}

async function onSaved(item: AgendaItemDto, created: boolean) {
  await refresh();
  announce(
    created
      ? t("agenda.created", {
          number: agendaNumberInText(
            numbers.value.get(item.id),
            t("agenda.unlisted.inText"),
          ),
          title: item.title,
        })
      : t("agenda.updated", { title: item.title }),
  );
  toast.add({
    title: created ? t("agenda.createdToast") : t("agenda.updatedToast"),
    description: item.title,
    color: "success",
    icon: "i-lucide-check",
  });
  void focusItem(item.id);
}

// New document ------------------------------------------------------------------

const addDocument = useAddDocument(agenda);

function openNewDocument(
  node: AgendaTreeNode<AgendaItemDto>,
  mode: "manager" | "member",
) {
  addDocument.openFor(node.item.id, mode);
}

async function onDocumentCreated(document: DocumentSummaryDto) {
  await refresh();
  announce(t("agenda.newDocument.createdFor", { title: document.title }));
}

// Context for the item nodes ----------------------------------------------------

function documentPath(document: DocumentSummaryDto): string {
  return sectionPath(`documentos/${encodeURIComponent(document.slug)}`);
}

/**
 * The editor of a draft the user's member presents, as the main presenter
 * or a co-presenter (the server lets every presenter edit a draft);
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

const context: AgendaTreeContext = {
  manage,
  organizing,
  isCollapsed: (itemId) => !organizing.value && collapsedIds.value.has(itemId),
  toggleFold,
  canCreateDocument,
  canSubmitDocument,
  busyId,
  documentsFor: (itemId) => documentsByItem.value.get(itemId) ?? [],
  documentPath,
  documentEditPath,
  canMove,
  canDelete,
  move: (itemId, move) => {
    void moveItem(itemId, move);
  },
  edit: openEdit,
  addChild: (node) => openCreate(node),
  toggleSubmissions: (item, value) => {
    void toggleSubmissions(item, value);
  },
  newDocument: openNewDocument,
};
provide(AGENDA_TREE_CONTEXT, context);

const documentTotal = computed(() => agenda.value?.documents.length ?? 0);
</script>

<template>
  <div v-if="assembly" class="space-y-6">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0 space-y-1">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-highlighted text-xl font-semibold">
            {{ t("agenda.title") }}
          </h2>
          <UBadge
            :color="agendaFinal ? 'success' : 'neutral'"
            variant="subtle"
            :icon="agendaFinal ? 'i-lucide-lock' : 'i-lucide-pencil-ruler'"
            :label="agendaFinal ? t('agenda.final') : t('agenda.provisional')"
          />
        </div>
        <p class="text-muted text-sm">
          {{ t("agenda.itemsCount", items.length) }} ·
          {{ t("agenda.documentsCount", documentTotal) }}
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <UButton
          v-if="addDocument.canAdd.value && tree.length > 0"
          icon="i-lucide-file-plus"
          :label="
            addDocument.manager.value
              ? t('agenda.newDocument.title')
              : t('agenda.newDocument.submitTitle')
          "
          @click="addDocument.openFor(null)"
        />
        <UButton
          v-if="manage && organizing"
          icon="i-lucide-plus"
          :label="t('agenda.addItem')"
          @click="openCreate(null)"
        />
        <UButton
          v-if="canOrganize && tree.length > 0"
          :color="organizing ? 'primary' : 'neutral'"
          :variant="organizing ? 'soft' : 'outline'"
          :icon="organizing ? 'i-lucide-check' : 'i-lucide-pencil-ruler'"
          :label="
            organizing ? t('agenda.organize.done') : t('agenda.organize.start')
          "
          @click="toggleOrganizing"
        />
        <!-- The rest, out of the first plane: one entry shows as itself,
             several fold into "Más". -->
        <UButton
          v-if="moreItems.length === 1 && moreItems[0]"
          color="neutral"
          variant="outline"
          v-bind="moreButton(moreItems[0])"
        />
        <UDropdownMenu
          v-else-if="moreItems.length > 1"
          :items="moreItems"
          :content="{ align: 'end' }"
        >
          <UButton
            icon="i-lucide-ellipsis"
            trailing-icon="i-lucide-chevron-down"
            color="neutral"
            variant="outline"
            :label="t('agenda.more')"
          />
        </UDropdownMenu>
        <AgendaFinalAction ref="finalAction" as="menu" />
      </div>
    </div>

    <p
      v-if="organizing"
      class="text-muted flex items-start gap-2 text-sm"
      data-testid="agenda-organize-hint"
    >
      <UIcon
        name="i-lucide-info"
        class="mt-0.5 size-4 shrink-0"
        aria-hidden="true"
      />
      <span>
        {{
          manage
            ? t("agenda.organize.hint")
            : t("agenda.organize.hintDocuments")
        }}
      </span>
    </p>

    <UAlert
      v-if="showSubmitBlocked && !organizing"
      color="neutral"
      variant="subtle"
      icon="i-lucide-lock"
      :title="submitBlockedReason ?? ''"
    />

    <!-- The planned date of the final agenda passed and it is still provisional -->
    <AgendaFinalAction v-if="tree.length > 0" as="reminder" />

    <p
      v-if="manage && agendaFinal && organizing"
      class="text-muted flex items-start gap-2 text-sm"
      data-testid="agenda-final-hint"
    >
      <UIcon
        name="i-lucide-lock"
        class="mt-0.5 size-4 shrink-0"
        aria-hidden="true"
      />
      <span>{{ t("agenda.finalAgenda.organizeHint") }}</span>
    </p>

    <!-- Loading -->
    <div v-if="pending && !agenda" class="space-y-3" role="status">
      <span class="sr-only">{{ t("agenda.loading") }}</span>
      <USkeleton
        v-for="index in 4"
        :key="index"
        aria-hidden="true"
        class="h-24 w-full"
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

    <!-- Empty -->
    <CommonEmptyState
      v-else-if="tree.length === 0"
      icon="i-lucide-list-tree"
      :title="t('agenda.emptyTitle')"
      :description="
        manage
          ? t('agenda.emptyManagerDescription')
          : t('agenda.emptyDescription')
      "
      variant="outline"
    >
      <template v-if="manage" #action>
        <UButton
          icon="i-lucide-plus"
          :label="t('agenda.addFirstItem')"
          @click="openCreate(null)"
        />
      </template>
    </CommonEmptyState>

    <!-- Tree -->
    <template v-else>
      <div
        v-if="!organizing && foldableCount > 0"
        class="flex flex-wrap items-center justify-end gap-2"
        data-testid="agenda-fold-all"
      >
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          icon="i-lucide-chevrons-up-down"
          :label="t('agenda.fold.expandAll')"
          @click="expandAll"
        />
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          icon="i-lucide-chevrons-down-up"
          :label="t('agenda.fold.collapseAll')"
          @click="collapseAll"
        />
      </div>
      <ol class="space-y-4" :aria-label="t('agenda.title')">
        <AgendaItemNode v-for="node in tree" :key="node.item.id" :node="node" />
      </ol>
    </template>

    <p class="sr-only" aria-live="polite" role="status">{{ announcement }}</p>

    <AgendaItemFormModal
      v-model:open="formOpen"
      :api-base="apiBase"
      :item="formItem"
      :parent="formParent"
      :root-change="runRootChange"
      @saved="onSaved"
      @conflict="refresh()"
    />

    <AgendaNewDocumentModal
      v-model:open="addDocument.open.value"
      :api-base="apiBase"
      :base-path="sectionPath()"
      :items="addDocument.items.value"
      :item-id="addDocument.itemId.value"
      :mode="addDocument.mode.value"
      origin="agenda"
      @created="onDocumentCreated"
    />

    <!-- A change to the root items of a final agenda -->
    <UModal
      v-model:open="finalConfirmOpen"
      :title="t('agenda.finalAgenda.confirmChangeTitle')"
      :description="t('agenda.finalAgenda.confirmChangeDescription')"
    >
      <template #footer>
        <div class="flex w-full flex-wrap justify-end gap-2">
          <UButton
            color="neutral"
            variant="outline"
            :label="t('common.cancel')"
            @click="settleFinalConfirm(false)"
          />
          <UButton
            icon="i-lucide-check"
            :label="t('agenda.finalAgenda.confirmChange')"
            data-testid="agenda-confirm-final-change"
            @click="settleFinalConfirm(true)"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
