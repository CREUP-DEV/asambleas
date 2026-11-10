<script setup lang="ts">
import type { AssemblyDto, DocumentDto } from "~~/shared/types/api";
import { errorStatus } from "~/composables/api/useApi";
import {
  formatMemberList,
  isDocumentPresenter,
  presenterPartners,
} from "~/composables/document/documentPresenters";
import { formatDateTime } from "~/utils/format";
import {
  addAnotherPath,
  originOf,
  originPath,
} from "~/composables/document/agendaReturn";

/**
 * Authoring and management of a document (inside the assembly hub).
 *
 * Presenters use it while their draft is editable (`can.edit`), as a short
 * guided page in three numbered steps: 1) what it is (metadata), 2) the text
 * (upload a Word file, write it, or upload the PDF of a `file` document) and
 * 3) "Enviar a Secretaría" ("Volver a enviar" after a correction). A banner
 * says where the draft stands: expected by a date, or sent back with the
 * Secretaría's correction note. Co-presenters edit the draft like the main
 * presenter; the page tells each of them who they prepare it with and who
 * answers the amendments. Sending saves the data of step 1 and the
 * text first, so the presenter never has to press "Guardar" before it; while
 * the text is still missing the send button stays secondary, so the Word
 * upload is the one main action.
 *
 * Secretaría (`can.manage`) keeps it at every stage: before publication it
 * validates and publishes a presented document or asks for a correction
 * (with a note, back to draft). Publishing is the header's main action only
 * when there is something to validate or publish again, or the Secretaría
 * prepares the text itself; a draft still in a member's hands keeps its
 * "Publicar ahora" in the "Más" menu. Once the text is frozen the editor is hidden
 * and the metadata form (advanced options folded) and the status actions
 * (withdraw, postpone, publish again, delete before publication) remain.
 * Anyone else is sent to the document workspace.
 *
 * Opened right after adding the document on the home page or the agenda
 * (`?desde=inicio`, `?desde=orden-del-dia`), the header leads back there
 * and offers "Guardar y añadir otro", the dialog offers "Publicar y añadir
 * otro" ("Enviar y presentar otro"), and publishing or deleting returns
 * there (the agenda organized, at the item); the success toast links to the
 * document instead. "… y añadir otro" comes back with the new-document
 * modal open on the next item.
 *
 * A failed refresh never unmounts the editor: useDocument keeps the last
 * document loaded and the page keeps the last assembly, and the failure is
 * shown inline. The error state is only for a document that never loaded.
 */

const route = useRoute();
const { t, locale } = useI18n();
const toast = useToast();
const { send, notifyError, isConflict } = useApi();
const { assembly: hubAssembly, sectionPath } = useCurrentAssembly();
const me = useMe();
const now = useAppNow();

// Last assembly loaded: a failed hub refresh must not unmount the editor.
const lastAssembly = shallowRef<AssemblyDto | null>(hubAssembly.value);
watch(hubAssembly, (value) => {
  if (value) lastAssembly.value = value;
});
const assembly = computed(() => hubAssembly.value ?? lastAssembly.value);

const assemblyParam = computed(() => String(route.params.assembly ?? ""));
const documentParam = computed(() => String(route.params.document ?? ""));

const { document, pending, error, stale, refresh } = await useDocument(
  assemblyParam,
  documentParam,
);

// Names the document in the breadcrumb row, from the DTO loaded above.
useDocumentBreadcrumb(document);

/** Secretaría-level management (document:manage) at any stage. */
const manager = computed(() => Boolean(document.value?.can.manage));
/** A presenter preparing their draft: the guided, numbered layout. */
const guided = computed(
  () => Boolean(document.value?.can.edit) && !manager.value,
);
/** The working text (or the draft's PDF) can still change. */
const textEditable = computed(() => Boolean(document.value?.can.edit));
/** Who may stay on this page; undefined until the document loads. */
const canAccess = computed(() => {
  const capabilities = document.value?.can;
  return capabilities ? capabilities.edit || capabilities.manage : undefined;
});

const documentApi = computed(
  () =>
    `/api/assemblies/${encodeURIComponent(assembly.value?.id ?? assemblyParam.value)}/documents/${encodeURIComponent(document.value?.id ?? documentParam.value)}`,
);

const workspacePath = computed(() =>
  sectionPath(
    `documentos/${encodeURIComponent(document.value?.slug ?? documentParam.value)}`,
  ),
);
const documentsPath = computed(() => sectionPath("documentos"));

/**
 * Opened right after adding it on the home page or the agenda: the way
 * back is there, and "… y añadir otro" returns with the new-document modal
 * open on the next item.
 */
const origin = computed(() => originOf(route.query));
const fromOrigin = computed(() => origin.value !== null);
const originReturnPath = computed(() =>
  originPath(
    origin.value ?? "agenda",
    sectionPath(),
    document.value?.agendaItemId ?? "",
  ),
);
const addAnotherTarget = computed(() =>
  addAnotherPath(
    origin.value ?? "agenda",
    sectionPath(),
    document.value?.agendaItemId ?? "",
  ),
);
/** i18n keys of the way back ("Volver al orden del día", "Volver al inicio"). */
const originLabels = computed(() =>
  origin.value === "home"
    ? {
        back: "document.authoring.backToHome",
        returning: "document.authoring.returningToHome",
      }
    : {
        back: "document.authoring.backToAgenda",
        returning: "document.authoring.returningToAgenda",
      },
);

useHead({
  title: () =>
    document.value
      ? `${t("document.authoring.pageTitle")}: ${document.value.title}`
      : t("document.authoring.pageTitle"),
});

// Leaving -------------------------------------------------------------------

/**
 * Set when this page navigates away on purpose: no unsaved-changes prompt, and
 * the template shows the redirecting state rather than the document (which a
 * live refresh may already report as gone, e.g. a 404 right after a delete).
 */
const leaving = ref(false);
/** Accessible label of the redirecting state (where the page is going). */
const leavingLabel = ref("document.authoring.redirecting");

async function leaveTo(
  path: string,
  labelKey = "document.authoring.redirecting",
): Promise<void> {
  leavingLabel.value = labelKey;
  leaving.value = true;
  const failure = await navigateTo(path, { replace: true });
  // A blocked or superseded navigation leaves the user here: show the page.
  if (import.meta.client && failure) leaving.value = false;
}

if (canAccess.value === false) {
  await leaveTo(workspacePath.value);
}

// The text froze (published) or the draft left the presenter's hands
// (submitted, withdrawn). Managers stay to edit metadata and status.
watch(
  [() => document.value?.can.edit, canAccess],
  ([editable, allowed], [before]) => {
    if (leaving.value) return;
    if (editable === false && before === true) {
      toast.add({
        id: "document-not-editable",
        title:
          allowed === false
            ? t("document.authoring.noLongerEditable")
            : t("document.authoring.frozen.notice"),
        color: "info",
        icon: "i-lucide-lock",
      });
    }
    if (allowed === false) void leaveTo(workspacePath.value);
  },
);

// Child state ---------------------------------------------------------------

interface DraftEditorHandle {
  save: () => Promise<boolean>;
  flush: () => void;
  dirty: boolean;
}
const draftEditor = useTemplateRef<DraftEditorHandle>("draftEditor");

interface MetadataFormHandle {
  check: () => Promise<boolean>;
  save: () => Promise<boolean>;
}
const metadataForm = useTemplateRef<MetadataFormHandle>("metadataForm");

const textDirty = ref(false);
const metadataDirty = ref(false);

/**
 * The Secretaría's data panel beside the text: closed, the editor takes the
 * full width. The form stays mounted either way (publishing saves it), and
 * opens itself when it has something to show. Remembered per browser.
 */
const dataPanel = useCookie<boolean>("asambleas-editor-data-panel", {
  default: () => false,
  maxAge: 60 * 60 * 24 * 365,
  sameSite: "lax",
});

/** The Secretaría's editor is on the page: the PDF export goes beside it. */
const editorHere = computed(
  () => !guided.value && isStructured.value && textEditable.value,
);

/** Opens the data panel so the form can show what is wrong. */
async function showData(): Promise<void> {
  if (dataPanel.value) return;
  dataPanel.value = true;
  await nextTick();
}
const draftBlockCount = ref(0);

const isStructured = computed(() => document.value?.format === "structured");

// The editor unmounts once the text is frozen; its unsaved state goes too.
watch(textEditable, (editable) => {
  if (!editable) textDirty.value = false;
});

function storeDocument(updated: DocumentDto): void {
  document.value = updated;
}

async function refetch(): Promise<void> {
  await refresh();
}

const refreshing = ref(false);

async function retryRefresh(): Promise<void> {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    await refresh();
  } finally {
    refreshing.value = false;
  }
}

onBeforeRouteLeave(() => {
  if (leaving.value || (!textDirty.value && !metadataDirty.value)) return true;
  return window.confirm(t("document.authoring.leaveConfirm"));
});

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (leaving.value || (!textDirty.value && !metadataDirty.value)) return;
  event.preventDefault();
  event.returnValue = "";
}
onMounted(() => window.addEventListener("beforeunload", onBeforeUnload));
onBeforeUnmount(() =>
  window.removeEventListener("beforeunload", onBeforeUnload),
);

// Submit and publish ----------------------------------------------------------

const canSubmit = computed(
  () =>
    document.value?.status === "draft" &&
    document.value.can.edit &&
    !document.value.can.publish,
);
const canPublish = computed(() => Boolean(document.value?.can.publish));
/** Publishing again a withdrawn or postponed document. */
const republish = computed(() => document.value?.publishedAt != null);

/** Publishing a document a presenter sent: the Secretaría validates it. */
const validating = computed(
  () => document.value?.status === "submitted" && !republish.value,
);
const canAskCorrection = computed(
  () => manager.value && document.value?.status === "submitted",
);

/**
 * Publishing as the header's primary action: validating what a presenter
 * sent, publishing again, a text with no presenter (or the manager's own
 * member), or one the Secretaría opened from the agenda to supply the text
 * itself ("Crear y subir el texto"). Otherwise the draft is still with a
 * member, and "Publicar ahora" is a secondary button (DocumentManageActions).
 */
const publishPrimary = computed(() => {
  const current = document.value;
  if (!current || !canPublish.value) return false;
  if (validating.value || republish.value || fromOrigin.value) return true;
  return (
    current.proponent === null ||
    isDocumentPresenter(current, me.member.value?.id)
  );
});

/**
 * A presenter sharing the document with other members: who they are and
 * who answers the amendments (null when presenting it alone).
 */
const partners = computed(() =>
  document.value
    ? presenterPartners(document.value, me.member.value?.id)
    : null,
);
const partnerList = computed(() =>
  formatMemberList(
    partners.value?.others.map((member) => member.acronym) ?? [],
    locale.value,
  ),
);
const partnersAnswer = computed(() => {
  const current = partners.value;
  if (!current?.main) return "";
  return current.mainIsMine
    ? t("document.presenters.mainIsYours", { member: current.main.acronym })
    : t("document.presenters.mainIsOther", { member: current.main.acronym });
});

/** The Secretaría asked for a correction: sending again. */
const resending = computed(() =>
  Boolean(document.value?.correctionRequestedAt),
);

/** Step 2 is still empty: no text (structured) or no PDF (file). */
const contentMissing = computed(() =>
  isStructured.value ? draftBlockCount.value === 0 : !document.value?.fileUrl,
);

const dialogMode = ref<"submit" | "publish">("publish");
const dialogOpen = ref(false);
const acting = ref(false);
/** A status change or a deletion from the manage menu is running. */
const managing = ref(false);
const busy = computed(() => acting.value || managing.value);
const actionStatus = ref("");

/**
 * i18n namespace of the dialog action ("submit", "publish", "validate",
 * "republish").
 */
function actionKey(mode: "submit" | "publish"): string {
  if (mode === "submit") return mode;
  if (republish.value) return "republish";
  return validating.value ? "validate" : "publish";
}

async function openDialog(mode: "submit" | "publish"): Promise<void> {
  draftEditor.value?.flush();
  // Invalid data: point at the field instead of opening the dialog (they
  // are saved on confirm, and a modal would keep the focus away from it).
  const form = metadataForm.value;
  if (metadataDirty.value && form && !(await form.check())) {
    // Hidden, the field it points at cannot take the focus: show it.
    if (!dataPanel.value) {
      await showData();
      await form.check();
    }
    return;
  }
  dialogMode.value = mode;
  dialogOpen.value = true;
}

/**
 * Saves the data and the text before leaving: true when everything on screen
 * is stored (otherwise the form or the editor says why).
 */
async function saveEverything(): Promise<boolean> {
  draftEditor.value?.flush();
  if (metadataDirty.value && metadataForm.value) {
    if (!(await metadataForm.value.save())) {
      await showData();
      return false;
    }
    await nextTick();
  }
  if (isStructured.value && textEditable.value && draftEditor.value) {
    const saved = await draftEditor.value.save();
    if (!saved || draftEditor.value?.dirty) return false;
  }
  return true;
}

/** "Guardar y añadir otro": keep the draft as it is and go on. */
async function saveAndAddAnother(): Promise<void> {
  if (acting.value) return;
  acting.value = true;
  try {
    if (!(await saveEverything())) return;
    toast.add({
      title: t("document.authoring.savedForLater"),
      color: "success",
      icon: "i-lucide-check",
    });
    await leaveTo(addAnotherTarget.value, originLabels.value.returning);
  } finally {
    acting.value = false;
  }
}

async function confirmAction(addAnother = false): Promise<void> {
  const current = document.value;
  if (!current || acting.value) return;
  const mode = dialogMode.value;
  const key = actionKey(mode);
  acting.value = true;
  actionStatus.value = t(`document.${key}.working`);
  try {
    // The data first: its PUT locks on updatedAt, the text on its hash.
    if (metadataDirty.value && metadataForm.value) {
      const saved = await metadataForm.value.save();
      if (!saved) {
        // The form shows why (field errors or a conflict notice).
        actionStatus.value = "";
        dialogOpen.value = false;
        await showData();
        return;
      }
      await nextTick();
    }
    if (isStructured.value && draftEditor.value) {
      const saved = await draftEditor.value.save();
      // Never freeze or submit an older copy than the one on screen.
      if (!saved || draftEditor.value?.dirty) {
        // The editor explains why (conflict panel or toast); show it.
        actionStatus.value = "";
        dialogOpen.value = false;
        return;
      }
    }
    const updated = await send<DocumentDto>(`${documentApi.value}/${mode}`, {
      body: { updatedAt: document.value?.updatedAt ?? current.updatedAt },
    });
    const next = addAnother && fromOrigin.value;
    const stays = mode === "submit" && updated.can.edit && !next;
    // Published from the home page or the agenda: back there, or on to the
    // next document with "… y añadir otro".
    const toOrigin =
      !stays && (next || (mode === "publish" && fromOrigin.value));
    const destination = next
      ? addAnotherTarget.value
      : toOrigin
        ? originReturnPath.value
        : workspacePath.value;
    const published = workspacePath.value;
    if (!stays) leaving.value = true;
    storeDocument(updated);
    dialogOpen.value = false;
    actionStatus.value = t(`document.${key}.success`);
    toast.add({
      title: t(`document.${key}.success`),
      description:
        mode === "publish" && updated.reference
          ? t("document.publish.successReference", {
              reference: updated.reference,
            })
          : undefined,
      color: "success",
      icon: "i-lucide-check",
      actions: toOrigin
        ? [
            {
              label: t("document.authoring.backToWorkspace"),
              color: "neutral",
              variant: "outline",
              onClick: () => {
                void navigateTo(published);
              },
            },
          ]
        : undefined,
    });
    if (!stays) {
      await leaveTo(
        destination,
        toOrigin
          ? originLabels.value.returning
          : "document.authoring.redirecting",
      );
    }
  } catch (failure) {
    actionStatus.value = "";
    notifyError(failure, `document.${mode}.error`);
    if (isConflict(failure)) await refetch();
  } finally {
    acting.value = false;
  }
}

// Correction --------------------------------------------------------------

const correctionOpen = ref(false);

// Deadlines for presenters ----------------------------------------------------

// Shared with the hub's agenda pages and the metadata form (same key).
const { data: agenda } = useAssemblyAgenda();

/**
 * Not bound by the calendar's deadline for presenting documents (same rule
 * as the server): a document the Secretaría expects, because it set an
 * internal deadline (`dueAt`, which governs instead) or put it under an
 * item that takes no submissions, and a draft sent back for a correction,
 * which reopens the presentation. The automatic sub-item of a document
 * presented under an item that takes them never exempts it.
 */
const deadlineExempt = computed(() => {
  const current = document.value;
  if (!current) return false;
  if (current.dueAt || resending.value) return true;
  const item = agenda.value?.items.find(
    (candidate) => candidate.id === current.agendaItemId,
  );
  return item?.acceptsSubmissions === false && !item.auto;
});

/** The calendar's deadline for presenting documents, when it applies. */
const documentsClose = computed(() =>
  deadlineExempt.value
    ? null
    : (assembly.value?.milestones.find((m) => m.key === "documents_close")
        ?.at ?? null),
);

/** The internal deadline, unless a correction made a passed one moot. */
const shownDueAt = computed(() => {
  const due = document.value?.dueAt ?? null;
  if (!due || !resending.value) return due;
  return new Date(due).getTime() > now.value ? due : null;
});

const loadErrorStatus = computed(() => errorStatus(error.value));

/** The voted PDF of a `file` document can no longer be replaced. */
const fileReplaceable = computed(() => document.value?.finalVote == null);

// Manage actions ----------------------------------------------------------

async function onDeleted(): Promise<void> {
  // Unsaved edits die with the document; never prompt for them.
  if (fromOrigin.value) {
    await leaveTo(originReturnPath.value, originLabels.value.returning);
    return;
  }
  await leaveTo(documentsPath.value, "document.authoring.returningToDocuments");
}
</script>

<template>
  <div class="space-y-6">
    <!--
      Leaving after a delete, publish or submit: a live refresh may already
      have dropped the document (404), so never flash the not-found state.
    -->
    <div v-if="leaving" class="space-y-3" role="status">
      <span class="sr-only">{{ t(leavingLabel) }}</span>
      <USkeleton aria-hidden="true" class="h-8 w-2/3" />
      <USkeleton aria-hidden="true" class="h-64 w-full" />
    </div>

    <!-- Loading -->
    <div v-else-if="!document && pending" class="space-y-4" role="status">
      <span class="sr-only">{{ t("document.authoring.loading") }}</span>
      <USkeleton aria-hidden="true" class="h-4 w-32" />
      <USkeleton aria-hidden="true" class="h-8 w-3/4 max-w-xl" />
      <div class="flex gap-2">
        <USkeleton aria-hidden="true" class="h-6 w-20" />
        <USkeleton aria-hidden="true" class="h-6 w-28" />
      </div>
      <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)]">
        <USkeleton aria-hidden="true" class="h-96 w-full" />
        <USkeleton aria-hidden="true" class="h-96 w-full" />
      </div>
    </div>

    <!-- Error -->
    <CommonEmptyState
      v-else-if="!document"
      :icon="
        loadErrorStatus === 404
          ? 'i-lucide-file-question'
          : 'i-lucide-cloud-off'
      "
      :title="
        loadErrorStatus === 404
          ? t('document.authoring.notFound')
          : t('document.authoring.loadError')
      "
      :description="
        loadErrorStatus === 404
          ? t('document.authoring.notFoundDescription')
          : t('document.authoring.loadErrorDescription')
      "
    >
      <!-- The way back is the breadcrumb row, above -->
      <template v-if="loadErrorStatus !== 404" #action>
        <UButton
          icon="i-lucide-refresh-ccw"
          :label="t('document.authoring.retry')"
          @click="refetch"
        />
      </template>
    </CommonEmptyState>

    <!-- Redirecting anyone who can neither edit nor manage -->
    <div v-else-if="!canAccess || !assembly" class="space-y-3" role="status">
      <span class="sr-only">{{ t("document.authoring.redirecting") }}</span>
      <USkeleton aria-hidden="true" class="h-8 w-2/3" />
      <USkeleton aria-hidden="true" class="h-64 w-full" />
    </div>

    <template v-else>
      <DocumentHeader
        :document="document"
        :assembly="assembly"
        :progress="false"
        :show-answerer="!(guided && partners)"
      >
        <UButton
          v-if="fromOrigin"
          :to="originReturnPath"
          color="neutral"
          variant="ghost"
          icon="i-lucide-arrow-left"
          :label="t(originLabels.back)"
        />
        <UButton
          :to="workspacePath"
          color="neutral"
          variant="ghost"
          :icon="fromOrigin ? 'i-lucide-file-text' : 'i-lucide-arrow-left'"
          :label="t('document.authoring.backToWorkspace')"
        />
        <!-- Adding several in a row: keep this one as it is and go on -->
        <UButton
          v-if="fromOrigin && textEditable"
          color="neutral"
          variant="outline"
          icon="i-lucide-file-plus"
          :label="t('document.authoring.saveAndAddAnother')"
          :disabled="busy"
          @click="saveAndAddAnother"
        />
        <!-- Presenters send from step 3; managers decide here -->
        <UButton
          v-if="publishPrimary"
          :icon="
            republish
              ? 'i-lucide-rotate-ccw'
              : validating
                ? 'i-lucide-badge-check'
                : 'i-lucide-megaphone'
          "
          :label="
            republish
              ? t('document.republish.button')
              : validating
                ? t('document.validate.button')
                : t('document.publish.button')
          "
          :disabled="busy"
          @click="openDialog('publish')"
        />
        <UButton
          v-if="canAskCorrection"
          color="warning"
          variant="outline"
          icon="i-lucide-undo-2"
          :label="t('document.correction.button')"
          :disabled="busy"
          @click="correctionOpen = true"
        />
        <!-- The data beside the text, or out of the way -->
        <DocumentDataToggle
          v-if="!guided"
          v-model:open="dataPanel"
          :dirty="metadataDirty"
        />
        <!-- Managers export the draft to check how it prints (beside the
             text when the editor is here) -->
        <ExportButton
          v-if="manager && isStructured && !editorHere"
          :assembly="assembly.id"
          :document="document.id"
          variant="clean"
          button-variant="outline"
        />
        <DocumentManageActions
          v-if="manager"
          v-model:busy="managing"
          :document="document"
          :document-api="documentApi"
          :disabled="acting"
          :publishable="canPublish && !publishPrimary"
          @updated="storeDocument"
          @stale="refetch"
          @deleted="onDeleted"
          @publish="openDialog('publish')"
        />
      </DocumentHeader>

      <p class="sr-only" role="status" aria-live="polite">
        {{ actionStatus }}
      </p>

      <!-- A refresh failed: the last copy (and unsaved edits) stay on screen -->
      <UAlert
        v-if="stale"
        color="warning"
        variant="subtle"
        icon="i-lucide-cloud-off"
        :title="t('document.authoring.refreshError.title')"
        :description="t('document.authoring.refreshError.description')"
        :actions="[
          {
            label: t('document.authoring.retry'),
            color: 'warning',
            variant: 'outline',
            size: 'sm',
            icon: 'i-lucide-refresh-ccw',
            loading: refreshing,
            onClick: retryRefresh,
          },
        ]"
        role="alert"
      />

      <!-- Where it stands and what comes next (draft, sent, correction) -->
      <DocumentProgressBanner
        :document="document"
        :audience="guided ? 'presenter' : 'manager'"
      />
      <UAlert
        v-if="
          document.status === 'withdrawn' || document.status === 'postponed'
        "
        color="neutral"
        variant="subtle"
        icon="i-lucide-archive"
        :title="t(`document.authoring.inactive.${document.status}`)"
        :description="
          canPublish ? t('document.republish.description') : undefined
        "
      />

      <!-- Co-presenters: who they prepare it with, who answers -->
      <p
        v-if="guided && partners"
        class="text-default flex max-w-4xl items-start gap-2 text-sm"
        data-testid="document-partners"
      >
        <UIcon
          name="i-lucide-users"
          class="text-muted mt-0.5 size-4 shrink-0"
          aria-hidden="true"
        />
        <span>
          {{ t("document.presenters.workingWith", { members: partnerList }) }}
          {{ partnersAnswer }}
        </span>
      </p>

      <!-- Presenters: three numbered steps -->
      <div v-if="guided" class="max-w-4xl space-y-8">
        <section class="space-y-3" aria-labelledby="document-step-what">
          <h3
            id="document-step-what"
            class="text-highlighted flex items-center gap-2 text-base font-semibold"
          >
            <span
              class="bg-primary text-inverted inline-flex size-6 items-center justify-center rounded-full text-xs tabular-nums"
              aria-hidden="true"
              >1</span
            >
            {{ t("document.authoring.steps.what") }}
          </h3>
          <UCard :ui="{ body: 'p-4 sm:p-5' }">
            <DocumentMetadataForm
              ref="metadataForm"
              v-model:dirty="metadataDirty"
              :document="document"
              :assembly="assembly"
              secondary-save
              @saved="storeDocument"
              @stale="refetch"
            />
          </UCard>
        </section>

        <section class="space-y-3" aria-labelledby="document-step-text">
          <h3
            id="document-step-text"
            class="text-highlighted flex items-center gap-2 text-base font-semibold"
          >
            <span
              class="bg-primary text-inverted inline-flex size-6 items-center justify-center rounded-full text-xs tabular-nums"
              aria-hidden="true"
              >2</span
            >
            {{
              isStructured
                ? t("document.authoring.steps.text")
                : t("document.authoring.steps.pdf")
            }}
          </h3>
          <!-- Text or PDF, in view while it can still change -->
          <DocumentFormatSwitch
            v-if="textEditable"
            :document="document"
            :document-api="documentApi"
            :disabled="busy"
            :pending="textDirty || metadataDirty"
            @updated="storeDocument"
            @stale="refetch"
          />
          <DocumentDraftEditor
            v-if="isStructured"
            ref="draftEditor"
            v-model:dirty="textDirty"
            v-model:block-count="draftBlockCount"
            :document="document"
            :document-api="documentApi"
            :disabled="busy"
            labelledby="document-step-text"
            @saved="storeDocument"
            @stale="refetch"
          />
          <DocumentFileUpload
            v-else
            :document="document"
            :document-api="documentApi"
            :disabled="busy"
            :replaceable="fileReplaceable"
            @uploaded="storeDocument"
            @stale="refetch"
          />
        </section>

        <section class="space-y-3" aria-labelledby="document-step-send">
          <h3
            id="document-step-send"
            class="text-highlighted flex items-center gap-2 text-base font-semibold"
          >
            <span
              class="bg-primary text-inverted inline-flex size-6 items-center justify-center rounded-full text-xs tabular-nums"
              aria-hidden="true"
              >3</span
            >
            {{ t("document.authoring.steps.send") }}
          </h3>
          <UCard :ui="{ body: 'p-4 sm:p-5 space-y-4' }">
            <p class="text-default text-sm">
              {{ t("document.authoring.sendHelp") }}
            </p>
            <dl
              v-if="shownDueAt || documentsClose"
              class="grid gap-3 text-sm sm:grid-cols-2"
            >
              <div v-if="shownDueAt">
                <dt class="text-muted text-xs font-medium">
                  {{ t("document.authoring.dueAt") }}
                </dt>
                <dd class="text-highlighted font-medium">
                  {{ formatDateTime(shownDueAt, { style: "long", locale }) }}
                </dd>
                <dd>
                  <CommonCountdown
                    :to="shownDueAt"
                    :urgent-hours="48"
                    icon="i-lucide-hourglass"
                  />
                </dd>
              </div>
              <div v-if="documentsClose">
                <dt class="text-muted text-xs font-medium">
                  {{ t("document.submit.deadline") }}
                </dt>
                <dd class="text-highlighted font-medium">
                  {{
                    formatDateTime(documentsClose, { style: "long", locale })
                  }}
                </dd>
                <dd>
                  <CommonCountdown
                    :to="documentsClose"
                    :urgent-hours="48"
                    icon="i-lucide-hourglass"
                  />
                </dd>
              </div>
            </dl>
            <template v-if="canSubmit">
              <!-- Until step 2 has text, the Word upload is the main action -->
              <p
                v-if="contentMissing"
                id="document-send-hint"
                class="text-muted flex items-start gap-2 text-sm"
              >
                <UIcon
                  name="i-lucide-arrow-up"
                  class="mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
                {{
                  isStructured
                    ? t("document.authoring.sendNeedsText")
                    : t("document.authoring.sendNeedsPdf")
                }}
              </p>
              <UButton
                size="lg"
                icon="i-lucide-send"
                :color="contentMissing ? 'neutral' : 'primary'"
                :variant="contentMissing ? 'outline' : 'solid'"
                :label="
                  resending
                    ? t('document.submit.resend')
                    : t('document.submit.button')
                "
                :disabled="busy"
                :aria-describedby="
                  contentMissing ? 'document-send-hint' : undefined
                "
                @click="openDialog('submit')"
              />
            </template>
          </UCard>
        </section>
      </div>

      <!-- Secretaría: text and data side by side -->
      <div
        v-else
        class="grid items-start gap-6"
        :class="{
          'lg:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)]': dataPanel,
        }"
      >
        <div class="min-w-0 space-y-4">
          <!-- Text or PDF, in view while it can still change -->
          <DocumentFormatSwitch
            v-if="textEditable"
            :document="document"
            :document-api="documentApi"
            :disabled="busy"
            :pending="textDirty || metadataDirty"
            @updated="storeDocument"
            @stale="refetch"
          />
          <DocumentDraftEditor
            v-if="isStructured && textEditable"
            ref="draftEditor"
            v-model:dirty="textDirty"
            v-model:block-count="draftBlockCount"
            :document="document"
            :document-api="documentApi"
            :disabled="busy"
            @saved="storeDocument"
            @stale="refetch"
          >
            <template v-if="manager" #actions>
              <ExportButton
                :assembly="assembly.id"
                :document="document.id"
                variant="clean"
                button-variant="outline"
              />
            </template>
          </DocumentDraftEditor>
          <!-- Published text: frozen, changed only through amendments -->
          <section
            v-else-if="isStructured"
            class="space-y-3"
            aria-labelledby="document-text-frozen"
          >
            <div class="min-w-0">
              <h3
                id="document-text-frozen"
                class="text-highlighted text-base font-semibold"
              >
                {{ t("document.authoring.text") }}
              </h3>
              <DocumentContentStats
                v-if="document.baseVersion"
                :blocks="document.baseVersion.blocks"
              />
            </div>
            <UAlert
              color="info"
              variant="subtle"
              icon="i-lucide-lock"
              :title="t('document.authoring.frozen.title')"
              :description="t('document.authoring.frozen.description')"
              :actions="[
                {
                  label: t('document.authoring.backToWorkspace'),
                  to: workspacePath,
                  color: 'info',
                  variant: 'outline',
                  size: 'sm',
                  icon: 'i-lucide-file-text',
                },
              ]"
            />
          </section>
          <section v-else class="space-y-3" aria-labelledby="document-file">
            <h3
              id="document-file"
              class="text-highlighted text-base font-semibold"
            >
              {{ t("document.file.title") }}
            </h3>
            <UAlert
              v-if="!textEditable"
              color="info"
              variant="subtle"
              icon="i-lucide-lock"
              :title="t('document.authoring.frozen.fileTitle')"
              :description="
                fileReplaceable
                  ? t('document.authoring.frozen.fileDescription')
                  : t('document.authoring.frozen.fileVoted')
              "
            />
            <DocumentFileUpload
              :document="document"
              :document-api="documentApi"
              :disabled="busy"
              :replaceable="fileReplaceable"
              @uploaded="storeDocument"
              @stale="refetch"
            />
          </section>
        </div>

        <!-- Kept mounted while closed: publishing saves and checks it. Fixed
             in view as the text scrolls, scrolling on its own if taller. -->
        <aside
          v-show="dataPanel"
          id="document-data-panel"
          class="min-w-0 space-y-4 lg:sticky lg:top-4 lg:max-h-[calc(100dvh-var(--shell-banner-height,0px)-var(--ui-header-height)-var(--shell-breadcrumb-height,0px)-2rem)] lg:overflow-y-auto"
        >
          <UCard :ui="{ body: 'p-4 sm:p-5' }">
            <template #header>
              <div class="flex items-center justify-between gap-2">
                <h3 class="text-highlighted text-base font-semibold">
                  {{ t("document.metadata.heading") }}
                </h3>
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  icon="i-lucide-x"
                  :aria-label="t('document.metadata.hide')"
                  @click="dataPanel = false"
                />
              </div>
            </template>
            <!-- Publishing saves the data first: then it is the main action -->
            <DocumentMetadataForm
              ref="metadataForm"
              v-model:dirty="metadataDirty"
              :document="document"
              :assembly="assembly"
              :secondary-save="publishPrimary"
              @saved="storeDocument"
              @stale="refetch"
            />
          </UCard>
        </aside>
      </div>

      <DocumentPublishDialog
        v-model:open="dialogOpen"
        :mode="dialogMode"
        :document="document"
        :assembly="assembly"
        :block-count="draftBlockCount"
        :text-dirty="textDirty"
        :metadata-dirty="metadataDirty"
        :manager="manager"
        :deadline-exempt="deadlineExempt"
        :busy="acting"
        :add-another="fromOrigin"
        @confirm="confirmAction"
      />

      <DocumentCorrectionDialog
        v-if="manager"
        v-model:open="correctionOpen"
        :document="document"
        :document-api="documentApi"
        @corrected="storeDocument"
        @stale="refetch"
      />
    </template>
  </div>
</template>
