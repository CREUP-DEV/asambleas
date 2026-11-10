<script setup lang="ts">
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type { AgendaItemDto } from "~~/shared/types/api";
import {
  agendaDeleteRefusal,
  planAgendaDelete,
  type AgendaDeleteRefusal,
} from "~/utils/agendaDelete";
import {
  isAgendaFinalConflict,
  type AgendaRootChangeRunner,
  type AgendaTreeNode,
} from "~/utils/agendaTree";

/**
 * What the Secretaría does with one agenda item, as buttons with their text
 * in view: "Editar", "Añadir subpunto", "Añadir documentos" and "Eliminar".
 * It owns their dialogs and requests, and reloads the shared agenda after
 * each one, so a page only mounts it with the item's tree node.
 *
 * - "Editar" and "Añadir subpunto" open the item form (AgendaItemFormModal).
 *   Renaming a root item of a final agenda asks "¿Cambiarlo igualmente?"
 *   first, and again if the server answers 409 `agenda_final`.
 * - "Añadir documentos" opens the list of several documents
 *   (AgendaBulkDocumentsModal), for document managers. Not under the
 *   automatic sub-item of one document.
 * - "Eliminar" says exactly what goes with the item ("Se eliminarán 3
 *   subpuntos y 4 documentos", naming the first documents). Only amendments
 *   keep an item: then the dialog explains it instead of offering to
 *   delete, also when it is the server that says so (409
 *   `agenda_item_amendments`, or `agenda_item_live` during the session).
 *   A root item of a final agenda says so in the same dialog and goes
 *   confirmed.
 *
 * Item managers (assembly.can.manage) get the item actions and document
 * managers (document:manage) the documents; with neither, nothing renders.
 * `compact` is for the organize mode of the agenda, one bar per item.
 * Emits `deleted` once the item is gone, before the agenda reloads.
 */
const props = withDefaults(
  defineProps<{
    item: AgendaTreeNode<AgendaItemDto>;
    compact?: boolean;
  }>(),
  { compact: false },
);

const emit = defineEmits<{ deleted: [] }>();

const { t } = useI18n();
const toast = useToast();
const api = useApi();
const me = useMe();
const current = useCurrentAssembly();
const { assembly, apiBase, sectionPath } = current;
// Shares the agenda already loaded by the page (same fetch key).
const { data: agenda, refresh: refreshAgenda } = useAssemblyAgenda();

const dto = computed(() => props.item.item);
/** For the labels: an item without a number reads as not published. */
const named = computed(() => ({
  number: agendaNumberInText(props.item.number, t("agenda.unlisted.inText")),
  title: dto.value.title,
}));

const manage = computed(() => Boolean(assembly.value?.can.manage));
const canAddDocuments = computed(
  () => me.can(PERMISSION_KEYS.DOCUMENT_MANAGE) && !dto.value.auto,
);
const agendaFinal = computed(() => Boolean(assembly.value?.agendaFinalizedAt));

const size = computed(() => (props.compact ? "xs" : "sm"));

// Final agenda: confirm a change to a root item -----------------------------------

const finalConfirmOpen = ref(false);
let answerFinalConfirm: ((confirmed: boolean) => void) | null = null;

function askFinalChange(): Promise<boolean> {
  answerFinalConfirm?.(false);
  return new Promise((resolve) => {
    answerFinalConfirm = resolve;
    finalConfirmOpen.value = true;
  });
}

function settleFinalConfirm(confirmed: boolean): void {
  const answer = answerFinalConfirm;
  answerFinalConfirm = null;
  finalConfirmOpen.value = false;
  answer?.(confirmed);
}

// Closing the dialog any other way (Escape, outside click) is a no.
watch(finalConfirmOpen, (isOpen) => {
  if (!isOpen) settleFinalConfirm(false);
});

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
    // The agenda became final meanwhile: ask now and send it again.
    void current.refresh();
    if (!(await askFinalChange())) return null;
    return await run(true);
  }
};

// Edit and add a sub-item ----------------------------------------------------------

/** Dialogs mount on first use: organize mode has one bar per item. */
const formMounted = ref(false);
const formOpen = ref(false);
const formItem = ref<AgendaItemDto | null>(null);
const formParent = ref<{
  id: string;
  title: string;
  number: string | null;
} | null>(null);

function openEdit(): void {
  formItem.value = dto.value;
  formParent.value = null;
  formMounted.value = true;
  formOpen.value = true;
}

function openAddChild(): void {
  formItem.value = null;
  formParent.value = {
    id: dto.value.id,
    title: dto.value.title,
    number: props.item.number,
  };
  formMounted.value = true;
  formOpen.value = true;
}

async function onSaved(saved: AgendaItemDto, created: boolean): Promise<void> {
  toast.add({
    title: created ? t("agenda.createdToast") : t("agenda.updatedToast"),
    description: saved.title,
    color: "success",
    icon: "i-lucide-check",
  });
  await refreshAgenda();
}

// Add documents ---------------------------------------------------------------------

const bulkMounted = ref(false);
const bulkOpen = ref(false);

const bulkItem = computed(() => ({
  id: dto.value.id,
  ...named.value,
  acceptsSubmissions: dto.value.acceptsSubmissions,
  submissionKinds: dto.value.submissionKinds,
  hasDocuments: (agenda.value?.documents ?? []).some(
    (document) => document.agendaItemId === dto.value.id,
  ),
}));

function openBulk(): void {
  bulkMounted.value = true;
  bulkOpen.value = true;
}

// Delete -----------------------------------------------------------------------------

const deleteOpen = ref(false);
const deleting = ref(false);
/** What the server answered to a delete it refused. */
const refusal = ref<AgendaDeleteRefusal | null>(null);

const plan = computed(() =>
  planAgendaDelete(
    agenda.value?.items ?? [],
    agenda.value?.documents ?? [],
    dto.value.id,
  ),
);

/** Why the item cannot be deleted, in words; null when it can. */
const blocked = computed<string | null>(() => {
  if (refusal.value?.reason === "live") return t("agenda.delete.blockedLive");
  const count =
    refusal.value?.reason === "amendments"
      ? Math.max(refusal.value.documents, plan.value.blockedBy.length, 1)
      : plan.value.blockedBy.length;
  return count > 0
    ? t("agenda.delete.blockedAmendments", { count }, count)
    : null;
});

/** "Se eliminarán 3 subpuntos y 4 documentos." */
const summary = computed(() => {
  const { subItems, documents } = plan.value;
  const subItemsText = t(
    "agenda.delete.subItems",
    { count: subItems },
    subItems,
  );
  const documentsText = t(
    "agenda.delete.documents",
    { count: documents },
    documents,
  );
  if (subItems > 0 && documents > 0) {
    return t("agenda.delete.both", {
      subItems: subItemsText,
      documents: documentsText,
    });
  }
  if (subItems === 0 && documents === 0) return t("agenda.delete.onlyItem");
  const total = subItems + documents;
  return t(
    "agenda.delete.one",
    { what: subItems > 0 ? subItemsText : documentsText },
    total,
  );
});

/** A root item of a final agenda: the dialog says so and confirms it. */
const deleteAfterFinal = computed(
  () => agendaFinal.value && dto.value.parentId === null,
);

function askDelete(): void {
  refusal.value = null;
  deleteOpen.value = true;
}

async function confirmDelete(): Promise<void> {
  if (deleting.value || blocked.value) return;
  const title = dto.value.title;
  deleting.value = true;
  try {
    await api.send(
      `${apiBase.value}/agenda/${encodeURIComponent(dto.value.id)}`,
      {
        method: "DELETE",
        ...(deleteAfterFinal.value ? { query: { confirmFinal: true } } : {}),
      },
    );
    deleteOpen.value = false;
    toast.add({
      title: t("agenda.deletedToast"),
      description: title,
      color: "success",
      icon: "i-lucide-trash-2",
    });
    emit("deleted");
    void refreshAgenda();
  } catch (failure) {
    if (isAgendaFinalConflict(failure)) {
      // The agenda became final meanwhile: the dialog stays open and now
      // says so; deleting again sends the confirmation.
      await current.refresh();
      return;
    }
    const refused = agendaDeleteRefusal(failure);
    if (refused) {
      // The dialog stays open and explains why, with the agenda reloaded.
      refusal.value = refused;
      void refreshAgenda();
      return;
    }
    api.notifyError(failure, "agenda.deleteError");
    if (api.isConflict(failure)) {
      deleteOpen.value = false;
      await refreshAgenda();
    }
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <div
    v-if="manage || canAddDocuments"
    class="flex flex-wrap items-center gap-2"
    role="group"
    :aria-label="t('agenda.manage.group', named)"
    data-testid="agenda-item-manage"
  >
    <UButton
      v-if="manage"
      color="neutral"
      variant="outline"
      :size="size"
      icon="i-lucide-pencil"
      :label="t('common.edit')"
      :aria-label="t('agenda.manage.editOf', named)"
      data-testid="agenda-item-edit"
      @click="openEdit"
    />
    <UButton
      v-if="manage"
      color="neutral"
      variant="outline"
      :size="size"
      icon="i-lucide-list-plus"
      :label="t('agenda.actions.addSubItem')"
      :aria-label="t('agenda.manage.addSubItemOf', named)"
      data-testid="agenda-item-add-child"
      @click="openAddChild"
    />
    <UButton
      v-if="canAddDocuments"
      color="neutral"
      variant="outline"
      :size="size"
      icon="i-lucide-files"
      :label="t('agenda.manage.addDocuments')"
      :aria-label="t('agenda.manage.addDocumentsOf', named)"
      data-testid="agenda-item-add-documents"
      @click="openBulk"
    />
    <UButton
      v-if="manage"
      color="error"
      :variant="compact ? 'ghost' : 'outline'"
      :size="size"
      icon="i-lucide-trash-2"
      :label="t('common.delete')"
      :aria-label="t('agenda.manage.deleteOf', named)"
      data-testid="agenda-item-delete"
      @click="askDelete"
    />

    <AgendaItemFormModal
      v-if="formMounted"
      v-model:open="formOpen"
      :api-base="apiBase"
      :item="formItem"
      :parent="formParent"
      :root-change="runRootChange"
      @saved="onSaved"
      @conflict="refreshAgenda()"
    />

    <AgendaBulkDocumentsModal
      v-if="bulkMounted"
      v-model:open="bulkOpen"
      :api-base="apiBase"
      :base-path="sectionPath()"
      :item="bulkItem"
      @created="refreshAgenda()"
      @uploaded="refreshAgenda()"
    />

    <UModal
      v-model:open="deleteOpen"
      :title="
        blocked ? t('agenda.delete.blockedTitle') : t('agenda.deleteTitle')
      "
      :description="t('agenda.deleteDescription', named)"
      :dismissible="!deleting"
    >
      <template #body>
        <!-- Amendments (or the session) keep the item -->
        <div
          v-if="blocked"
          class="space-y-3"
          data-testid="agenda-delete-blocked"
        >
          <UAlert
            color="warning"
            variant="subtle"
            icon="i-lucide-shield-alert"
            :title="blocked"
            :description="
              refusal?.reason === 'live'
                ? undefined
                : t('agenda.delete.blockedHelp')
            "
          />
          <ul
            v-if="refusal?.reason !== 'live' && plan.blockedBy.length > 0"
            class="text-default list-disc space-y-1 ps-5 text-sm"
          >
            <li
              v-for="(title, index) in plan.blockedBy"
              :key="index"
              class="break-words"
            >
              {{ title }}
            </li>
          </ul>
        </div>

        <div v-else class="space-y-3 text-sm" data-testid="agenda-delete-plan">
          <p class="text-highlighted font-medium">{{ summary }}</p>
          <div v-if="plan.named.length > 0">
            <p class="text-muted">{{ t("agenda.delete.documentsList") }}</p>
            <ul class="text-default mt-1 list-disc space-y-1 ps-5">
              <li
                v-for="(title, index) in plan.named"
                :key="index"
                class="break-words"
              >
                {{ title }}
              </li>
              <li v-if="plan.unnamed > 0" class="text-muted">
                {{
                  t("agenda.delete.more", { count: plan.unnamed }, plan.unnamed)
                }}
              </li>
            </ul>
          </div>
          <p v-if="deleteAfterFinal" class="text-muted">
            {{ t("agenda.finalAgenda.deleteNote") }}
          </p>
          <p class="text-muted">{{ t("agenda.deleteIrreversible") }}</p>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full flex-wrap justify-end gap-2">
          <UButton
            color="neutral"
            variant="outline"
            :label="blocked ? t('common.close') : t('common.cancel')"
            :disabled="deleting"
            @click="deleteOpen = false"
          />
          <UButton
            v-if="!blocked"
            color="error"
            icon="i-lucide-trash-2"
            :label="t('common.delete')"
            :loading="deleting"
            data-testid="agenda-delete-confirm"
            @click="confirmDelete"
          />
        </div>
      </template>
    </UModal>

    <!-- Renaming a root item of a final agenda -->
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
            @click="settleFinalConfirm(true)"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
