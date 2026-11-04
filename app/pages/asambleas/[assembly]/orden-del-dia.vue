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
import type { AgendaMove, AgendaTreeNode } from "~/utils/agendaTree";

/**
 * Agenda (orden del día): the item tree with its documents. Managers add,
 * edit, move (buttons, keyboard accessible), switch submissions and delete
 * items; members present documents under items that accept them.
 */

const { t } = useI18n();
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
const rootsLocked = computed(() => Boolean(assembly.value?.agendaFinalizedAt));
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
 * Documents that keep an item from being deleted (server rule): presented
 * or public ones, and any document that was ever published, since it keeps
 * its reference, base text and amendments even after a withdrawal.
 */
const PROTECTED_STATUSES = new Set(["submitted", "published", "postponed"]);

function canDelete(itemId: string): boolean {
  const item = items.value.find((candidate) => candidate.id === itemId);
  if (!item) return false;
  if (item.parentId === null && rootsLocked.value) return false;
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

// Moves -------------------------------------------------------------------------

const busyId = ref<string | null>(null);

function canMove(itemId: string, move: AgendaMove): boolean {
  return canMoveAgendaItem(items.value, itemId, move, {
    rootsLocked: rootsLocked.value,
  });
}

async function moveItem(itemId: string, move: AgendaMove) {
  // Buttons stay enabled while busy (disabling them would drop focus).
  if (busyId.value || !agenda.value) return;
  const plan = planAgendaMove(items.value, itemId, move, {
    rootsLocked: rootsLocked.value,
  });
  if (!plan) return;

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
        body: { items: plan },
      },
    );
    agenda.value = updated;
    announce(
      t("agenda.moved", {
        title,
        number: numbers.value.get(itemId) ?? "",
      }),
    );
    if (import.meta.client && document.activeElement === document.body) {
      void focusItem(itemId, move);
    }
  } catch (failure) {
    agenda.value = previous;
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
const formParent = ref<{ id: string; title: string; number: string } | null>(
  null,
);

function openCreate(parent: AgendaTreeNode<AgendaItemDto> | null) {
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
          number: numbers.value.get(item.id) ?? "",
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

// Delete ------------------------------------------------------------------------

const deleteTarget = ref<AgendaTreeNode<AgendaItemDto> | null>(null);
const deleteOpen = ref(false);
const deleting = ref(false);

function askDelete(node: AgendaTreeNode<AgendaItemDto>) {
  deleteTarget.value = node;
  deleteOpen.value = true;
}

const deleteCounts = computed(() => {
  const node = deleteTarget.value;
  if (!node) return { children: 0, documents: 0 };
  const ids = agendaSubtreeIds(items.value, node.item.id);
  let documents = 0;
  for (const id of ids) documents += documentsByItem.value.get(id)?.length ?? 0;
  return { children: ids.size - 1, documents };
});

async function confirmDelete() {
  const node = deleteTarget.value;
  if (!node) return;
  deleting.value = true;
  try {
    await api.send(`${apiBase.value}/agenda/${node.item.id}`, {
      method: "DELETE",
    });
    deleteOpen.value = false;
    await refresh();
    announce(t("agenda.deleted", { title: node.item.title }));
    toast.add({
      title: t("agenda.deletedToast"),
      description: node.item.title,
      color: "success",
      icon: "i-lucide-trash-2",
    });
  } catch (failure) {
    api.notifyError(failure, "agenda.deleteError");
    if (api.isConflict(failure)) {
      deleteOpen.value = false;
      await refresh();
    }
  } finally {
    deleting.value = false;
  }
}

// New document ------------------------------------------------------------------

const documentOpen = ref(false);
const documentMode = ref<"manager" | "member">("member");
const documentItem = ref<{ id: string; title: string; number: string } | null>(
  null,
);

function openNewDocument(
  node: AgendaTreeNode<AgendaItemDto>,
  mode: "manager" | "member",
) {
  documentItem.value = {
    id: node.item.id,
    title: node.item.title,
    number: node.number,
  };
  documentMode.value = mode;
  documentOpen.value = true;
}

// Context for the item nodes ----------------------------------------------------

const context: AgendaTreeContext = {
  manage,
  rootsLocked,
  canCreateDocument,
  canSubmitDocument,
  submitBlockedReason,
  busyId,
  documentsFor: (itemId) => documentsByItem.value.get(itemId) ?? [],
  documentPath: (document) =>
    sectionPath(`documentos/${encodeURIComponent(document.slug)}`),
  canMove,
  canDelete,
  move: (itemId, move) => {
    void moveItem(itemId, move);
  },
  edit: openEdit,
  addChild: (node) => openCreate(node),
  remove: askDelete,
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
            :color="rootsLocked ? 'success' : 'neutral'"
            variant="subtle"
            :icon="rootsLocked ? 'i-lucide-lock' : 'i-lucide-pencil-ruler'"
            :label="rootsLocked ? t('agenda.final') : t('agenda.provisional')"
          />
        </div>
        <p class="text-muted text-sm">
          {{ t("agenda.itemsCount", items.length) }} ·
          {{ t("agenda.documentsCount", documentTotal) }}
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <UButton
          color="neutral"
          variant="outline"
          icon="i-lucide-scroll-text"
          :label="t('agenda.seeConvocation')"
          :to="sectionPath('convocatoria')"
        />
        <UTooltip
          v-if="manage"
          :text="
            rootsLocked ? t('agenda.rootsLockedShort') : t('agenda.addItem')
          "
        >
          <UButton
            icon="i-lucide-plus"
            :label="t('agenda.addItem')"
            :disabled="rootsLocked"
            @click="openCreate(null)"
          />
        </UTooltip>
      </div>
    </div>

    <UAlert
      v-if="manage && rootsLocked"
      color="info"
      variant="subtle"
      icon="i-lucide-lock"
      :title="t('agenda.rootsLockedTitle')"
      :description="t('agenda.rootsLockedDescription')"
      :actions="[
        {
          label: t('agenda.reopenInCalendar'),
          to: sectionPath('calendario'),
          color: 'info',
          variant: 'link',
          trailingIcon: 'i-lucide-arrow-right',
        },
      ]"
    />

    <!-- Loading -->
    <div
      v-if="pending && !agenda"
      class="space-y-3"
      aria-busy="true"
      :aria-label="t('agenda.loading')"
    >
      <USkeleton v-for="index in 4" :key="index" class="h-24 w-full" />
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
      <template v-if="manage && !rootsLocked" #action>
        <UButton
          icon="i-lucide-plus"
          :label="t('agenda.addFirstItem')"
          @click="openCreate(null)"
        />
      </template>
    </CommonEmptyState>

    <!-- Tree -->
    <ol v-else class="space-y-4" :aria-label="t('agenda.title')">
      <AgendaItemNode v-for="node in tree" :key="node.item.id" :node="node" />
    </ol>

    <p class="sr-only" aria-live="polite" role="status">{{ announcement }}</p>

    <AgendaItemFormModal
      v-model:open="formOpen"
      :api-base="apiBase"
      :item="formItem"
      :parent="formParent"
      @saved="onSaved"
      @conflict="refresh()"
    />

    <AgendaNewDocumentModal
      v-model:open="documentOpen"
      :api-base="apiBase"
      :base-path="sectionPath()"
      :item="documentItem"
      :mode="documentMode"
    />

    <UModal
      v-model:open="deleteOpen"
      :title="t('agenda.deleteTitle')"
      :description="
        deleteTarget
          ? t('agenda.deleteDescription', {
              number: deleteTarget.number,
              title: deleteTarget.item.title,
            })
          : ''
      "
      :dismissible="!deleting"
    >
      <template #body>
        <ul class="text-muted list-disc space-y-1 ps-5 text-sm">
          <li v-if="deleteCounts.children > 0">
            {{
              t(
                "agenda.deleteChildren",
                { count: deleteCounts.children },
                deleteCounts.children,
              )
            }}
          </li>
          <li v-if="deleteCounts.documents > 0">
            {{
              t(
                "agenda.deleteDocuments",
                { count: deleteCounts.documents },
                deleteCounts.documents,
              )
            }}
          </li>
          <li>{{ t("agenda.deleteIrreversible") }}</li>
        </ul>
      </template>
      <template #footer>
        <div class="flex w-full flex-wrap justify-end gap-2">
          <UButton
            color="neutral"
            variant="outline"
            :label="t('common.cancel')"
            :disabled="deleting"
            @click="deleteOpen = false"
          />
          <UButton
            color="error"
            icon="i-lucide-trash-2"
            :label="t('common.delete')"
            :loading="deleting"
            @click="confirmDelete"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
