<script setup lang="ts">
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type { DocumentDto } from "~~/shared/types/api";
import { errorStatus } from "~/composables/api/useApi";
import { formatDateTime } from "~/utils/format";

/**
 * Authoring of a document before publication (inside the assembly hub):
 * metadata, the working draft (or the PDF of a `file` document), DOCX
 * import, "Presentar" for members and "Publicar" for Secretaría. Anyone who
 * cannot edit is sent to the document workspace.
 */

const route = useRoute();
const { t, locale } = useI18n();
const toast = useToast();
const { send, notifyError, isConflict } = useApi();
const { can } = useMe();
const { assembly, sectionPath } = useCurrentAssembly();

const assemblyParam = computed(() => String(route.params.assembly ?? ""));
const documentParam = computed(() => String(route.params.document ?? ""));

const { document, pending, error, refresh } = await useDocument(
  assemblyParam,
  documentParam,
);

const manager = computed(() => can(PERMISSION_KEYS.DOCUMENT_MANAGE));

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

/** Set when this page navigates away on purpose (no unsaved-changes prompt). */
let leaving = false;

async function leaveTo(path: string): Promise<void> {
  leaving = true;
  await navigateTo(path, { replace: true });
}

if (document.value && !document.value.can.edit) {
  await leaveTo(workspacePath.value);
}

watch(
  () => document.value?.can.edit,
  (editable, before) => {
    if (editable !== false || leaving) return;
    if (before === true) {
      toast.add({
        id: "document-not-editable",
        title: t("document.authoring.noLongerEditable"),
        color: "info",
        icon: "i-lucide-lock",
      });
    }
    void leaveTo(workspacePath.value);
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

function storeDocument(updated: DocumentDto): void {
  document.value = updated;
}

async function refetch(): Promise<void> {
  await refresh();
}

onBeforeRouteLeave(() => {
  if (leaving || (!textDirty.value && !metadataDirty.value)) return true;
  return window.confirm(t("document.authoring.leaveConfirm"));
});

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (leaving || (!textDirty.value && !metadataDirty.value)) return;
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

const dialogMode = ref<"submit" | "publish">("publish");
const dialogOpen = ref(false);
const acting = ref(false);
const actionStatus = ref("");

function openDialog(mode: "submit" | "publish"): void {
  draftEditor.value?.flush();
  dialogMode.value = mode;
  dialogOpen.value = true;
}

async function confirmAction(): Promise<void> {
  const current = document.value;
  if (!current || acting.value) return;
  const mode = dialogMode.value;
  acting.value = true;
  actionStatus.value = t(`document.${mode}.working`);
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
    if (!stays) leaving = true;
    storeDocument(updated);
    dialogOpen.value = false;
    actionStatus.value = t(`document.${mode}.success`);
    toast.add({
      title: t(`document.${mode}.success`),
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
</script>

<template>
  <div class="space-y-6">
    <!-- Loading -->
    <div
      v-if="!document && pending"
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

    <!-- Redirecting non-editors -->
    <div
      v-else-if="!document.can.edit || !assembly"
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
          :disabled="acting"
          @click="openDialog('submit')"
        />
        <UButton
          v-if="canPublish"
          icon="i-lucide-megaphone"
          :label="t('document.publish.button')"
          :disabled="acting"
          @click="openDialog('publish')"
        />
      </DocumentHeader>

      <p class="sr-only" role="status" aria-live="polite">
        {{ actionStatus }}
      </p>

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
      />

      <div
        class="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)]"
      >
        <div class="min-w-0">
          <DocumentDraftEditor
            v-if="isStructured"
            ref="draftEditor"
            v-model:dirty="textDirty"
            v-model:block-count="draftBlockCount"
            :document="document"
            :document-api="documentApi"
            :disabled="acting"
            @saved="storeDocument"
            @stale="refetch"
          />
          <section v-else class="space-y-3" aria-labelledby="document-file">
            <h3
              id="document-file"
              class="text-highlighted text-base font-semibold"
            >
              {{ t("document.file.title") }}
            </h3>
            <DocumentFileUpload
              :document="document"
              :document-api="documentApi"
              :disabled="acting"
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
