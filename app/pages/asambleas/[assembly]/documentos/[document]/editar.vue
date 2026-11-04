<script setup lang="ts">
import type { AssemblyDto, DocumentDto } from "~~/shared/types/api";
import { errorStatus } from "~/composables/api/useApi";
import { formatDateTime } from "~/utils/format";

/**
 * Authoring and management of a document (inside the assembly hub).
 *
 * Presenters use it while their draft is editable (`can.edit`): metadata,
 * the working draft (or the PDF of a `file` document), DOCX import and
 * "Presentar". Secretaría (`can.manage`) keeps it at every stage: before
 * publication it also publishes; once the text is frozen the editor is
 * hidden and the metadata form (window override, majority, voted...) and the
 * status actions (withdraw, postpone, publish again, delete before
 * publication) remain. Anyone else is sent to the document workspace.
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

/** Secretaría-level management (document:manage) at any stage. */
const manager = computed(() => Boolean(document.value?.can.manage));
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

const textDirty = ref(false);
const metadataDirty = ref(false);
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

const dialogMode = ref<"submit" | "publish">("publish");
const dialogOpen = ref(false);
const acting = ref(false);
/** A status change or a deletion from the manage menu is running. */
const managing = ref(false);
const busy = computed(() => acting.value || managing.value);
const actionStatus = ref("");

/** i18n namespace of the dialog action ("submit", "publish", "republish"). */
function actionKey(mode: "submit" | "publish"): string {
  return mode === "publish" && republish.value ? "republish" : mode;
}

function openDialog(mode: "submit" | "publish"): void {
  draftEditor.value?.flush();
  dialogMode.value = mode;
  dialogOpen.value = true;
}

async function confirmAction(): Promise<void> {
  const current = document.value;
  if (!current || acting.value) return;
  const mode = dialogMode.value;
  const key = actionKey(mode);
  acting.value = true;
  actionStatus.value = t(`document.${key}.working`);
  try {
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
    const stays = mode === "submit" && updated.can.edit;
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
    });
    if (!stays) await leaveTo(workspacePath.value);
  } catch (failure) {
    actionStatus.value = "";
    notifyError(failure, `document.${mode}.error`);
    if (isConflict(failure)) await refetch();
  } finally {
    acting.value = false;
  }
}

// Deadline for members --------------------------------------------------------

const documentsClose = computed(
  () =>
    assembly.value?.milestones.find((m) => m.key === "documents_close")?.at ??
    null,
);

const loadErrorStatus = computed(() => errorStatus(error.value));

/** The voted PDF of a `file` document can no longer be replaced. */
const fileReplaceable = computed(() => document.value?.finalVote == null);

// Manage actions ----------------------------------------------------------

async function onDeleted(): Promise<void> {
  // Unsaved edits die with the document; never prompt for them.
  await leaveTo(documentsPath.value, "document.authoring.returningToDocuments");
}
</script>

<template>
  <div class="space-y-6">
    <!--
      Leaving after a delete, publish or submit: a live refresh may already
      have dropped the document (404), so never flash the not-found state.
    -->
    <div
      v-if="leaving"
      class="space-y-3"
      aria-busy="true"
      :aria-label="t(leavingLabel)"
    >
      <USkeleton class="h-8 w-2/3" />
      <USkeleton class="h-64 w-full" />
    </div>

    <!-- Loading -->
    <div
      v-else-if="!document && pending"
      class="space-y-4"
      aria-busy="true"
      :aria-label="t('document.authoring.loading')"
    >
      <USkeleton class="h-4 w-32" />
      <USkeleton class="h-8 w-3/4 max-w-xl" />
      <div class="flex gap-2">
        <USkeleton class="h-6 w-20" />
        <USkeleton class="h-6 w-28" />
      </div>
      <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)]">
        <USkeleton class="h-96 w-full" />
        <USkeleton class="h-96 w-full" />
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
      <template #action>
        <UButton
          v-if="loadErrorStatus !== 404"
          icon="i-lucide-refresh-ccw"
          :label="t('document.authoring.retry')"
          @click="refetch"
        />
        <UButton
          :to="documentsPath"
          color="neutral"
          variant="outline"
          icon="i-lucide-arrow-left"
          :label="t('document.authoring.backToDocuments')"
        />
      </template>
    </CommonEmptyState>

    <!-- Redirecting anyone who can neither edit nor manage -->
    <div
      v-else-if="!canAccess || !assembly"
      class="space-y-3"
      aria-busy="true"
      :aria-label="t('document.authoring.redirecting')"
    >
      <USkeleton class="h-8 w-2/3" />
      <USkeleton class="h-64 w-full" />
    </div>

    <template v-else>
      <DocumentHeader :document="document" :assembly="assembly">
        <UButton
          :to="workspacePath"
          color="neutral"
          variant="ghost"
          icon="i-lucide-arrow-left"
          :label="t('document.authoring.backToWorkspace')"
        />
        <UButton
          v-if="canSubmit"
          icon="i-lucide-send"
          :label="t('document.submit.button')"
          :disabled="busy"
          @click="openDialog('submit')"
        />
        <UButton
          v-if="canPublish"
          :icon="republish ? 'i-lucide-rotate-ccw' : 'i-lucide-megaphone'"
          :label="
            republish
              ? t('document.republish.button')
              : t('document.publish.button')
          "
          :disabled="busy"
          @click="openDialog('publish')"
        />
        <DocumentManageActions
          v-if="manager"
          v-model:busy="managing"
          :document="document"
          :document-api="documentApi"
          :disabled="acting"
          @updated="storeDocument"
          @stale="refetch"
          @deleted="onDeleted"
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

      <UAlert
        v-if="document.status === 'submitted'"
        color="info"
        variant="subtle"
        icon="i-lucide-inbox"
        :title="t('document.authoring.submittedTitle')"
        :description="
          document.submittedAt
            ? t('document.authoring.submittedDescription', {
                date: formatDateTime(document.submittedAt, { locale }),
              })
            : t('document.authoring.submittedNoDate')
        "
      />
      <UAlert
        v-else-if="
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

      <div
        class="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)]"
      >
        <div class="min-w-0">
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
          />
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

        <aside class="min-w-0 space-y-4">
          <UCard
            v-if="canSubmit && documentsClose"
            :ui="{ body: 'p-4 sm:p-4' }"
          >
            <p class="text-muted text-xs font-medium tracking-wide uppercase">
              {{ t("document.submit.deadline") }}
            </p>
            <p class="text-highlighted text-sm font-medium">
              {{ formatDateTime(documentsClose, { style: "long", locale }) }}
            </p>
            <CommonCountdown
              :to="documentsClose"
              :urgent-hours="48"
              icon="i-lucide-hourglass"
              class="text-sm"
            />
          </UCard>

          <UCard :ui="{ body: 'p-4 sm:p-5' }">
            <template #header>
              <h3 class="text-highlighted text-base font-semibold">
                {{ t("document.metadata.heading") }}
              </h3>
            </template>
            <DocumentMetadataForm
              v-model:dirty="metadataDirty"
              :document="document"
              :assembly="assembly"
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
        :busy="acting"
        @confirm="confirmAction"
      />
    </template>
  </div>
</template>
