<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";
import type { AssemblyDto } from "~~/shared/types/api";

/**
 * The convocatoria of the assembly, inside the hub like any other section.
 *
 * Once the Secretaría uploads the signed convocatoria (a PDF, POST
 * .../convocation), that PDF leads the page for everyone, in the same viewer
 * as an uploaded document. Until then the page shows the convocatoria
 * generated from the assembly, its agenda and its calendar
 * (ConvocationSheet), which managers can also open from "Más" while a signed
 * one leads. "Imprimir" opens the generated one alone, ready to print
 * (convocatoria/imprimir).
 *
 * Managers upload, replace or remove the PDF and edit the introduction of
 * the generated one here.
 */

const { t, locale } = useI18n();
const toast = useToast();
const api = useApi();
const current = useCurrentAssembly();
const { assembly, sectionPath } = current;

await useAssemblyAgenda();

const typeName = computed(() =>
  assembly.value ? t(`assembly.types.${assembly.value.type}`) : "",
);
/** "80.ª Asamblea General Ordinaria" / "80th Ordinary General Assembly". */
const fullName = computed(() =>
  assembly.value
    ? `${assemblyOrdinal(assembly.value.number, locale.value)} ${typeName.value}`
    : "",
);
const heading = computed(() =>
  t("convocation.heading", { assembly: fullName.value }),
);

useHead({
  title: () =>
    [t("shell.assembly.convocation"), assembly.value?.label]
      .filter(Boolean)
      .join(" · "),
});

const printPath = computed(() => sectionPath("convocatoria/imprimir"));

// Signed convocatoria -----------------------------------------------------------

const signed = computed(() => assembly.value?.convocationFile ?? null);
/** Managers looking at the generated convocatoria while a signed one leads. */
const showGenerated = ref(false);
const viewingSigned = computed(
  () => signed.value !== null && !showGenerated.value,
);

const sheet = useTemplateRef<{ startEditing: () => void }>("sheet");

const PDF_MAX_BYTES = 20 * 1024 * 1024;
const fileInput = useTemplateRef<HTMLInputElement>("fileInput");
const uploading = ref(false);
const removing = ref(false);
const confirmRemove = ref(false);
const announcement = ref("");

function chooseFile(): void {
  fileInput.value?.click();
}

function rejectFile(key: string): void {
  toast.add({
    title: t("convocation.signed.error"),
    description: t(key),
    color: "error",
    icon: "i-lucide-circle-alert",
  });
}

async function onFileChosen(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const selected = input.files?.[0];
  input.value = "";
  const target = assembly.value;
  if (!selected || !target) return;
  if (selected.type !== "application/pdf" && !/\.pdf$/i.test(selected.name)) {
    rejectFile("document.file.invalidType");
    return;
  }
  if (selected.size > PDF_MAX_BYTES) {
    rejectFile("document.file.tooLarge");
    return;
  }
  uploading.value = true;
  announcement.value = t("document.file.uploading", { name: selected.name });
  try {
    const body = new FormData();
    body.append("file", selected, selected.name);
    body.append("updatedAt", target.updatedAt);
    const updated = await api.send<AssemblyDto>(
      `${current.apiBase.value}/convocation`,
      { body },
    );
    current.setAssembly(updated);
    showGenerated.value = false;
    announcement.value = t("convocation.signed.uploaded");
    toast.add({
      title: t("convocation.signed.uploaded"),
      color: "success",
      icon: "i-lucide-check",
    });
  } catch (error) {
    announcement.value = "";
    const status = api.errorStatus(error);
    if (status === 415) rejectFile("document.file.invalidType");
    else if (status === 413) rejectFile("document.file.tooLarge");
    else api.notifyError(error, "convocation.signed.error");
    if (api.isConflict(error)) await current.refresh();
  } finally {
    uploading.value = false;
  }
}

async function removeSigned(): Promise<void> {
  const target = assembly.value;
  if (!target) return;
  removing.value = true;
  try {
    const updated = await api.send<AssemblyDto>(
      `${current.apiBase.value}/convocation`,
      { method: "DELETE", query: { updatedAt: target.updatedAt } },
    );
    current.setAssembly(updated);
    confirmRemove.value = false;
    showGenerated.value = false;
    announcement.value = t("convocation.signed.removed");
    toast.add({
      title: t("convocation.signed.removed"),
      color: "success",
      icon: "i-lucide-check",
    });
  } catch (error) {
    api.notifyError(error, "convocation.signed.removeError");
    if (api.isConflict(error)) await current.refresh();
  } finally {
    removing.value = false;
  }
}

/**
 * Everything but the page's one action, for managers: over the signed PDF,
 * the generated one and what to do with the PDF; over the generated one,
 * its introduction and the print view.
 */
const moreItems = computed<DropdownMenuItem[][]>(() => {
  if (!assembly.value?.can.manage) return [];
  if (viewingSigned.value) {
    return [
      [
        {
          label: t("convocation.signed.generated"),
          icon: "i-lucide-file-text",
          onSelect: () => {
            showGenerated.value = true;
          },
        },
        {
          label: t("convocation.signed.replace"),
          icon: "i-lucide-file-up",
          onSelect: chooseFile,
        },
      ],
      [
        {
          label: t("convocation.signed.remove"),
          icon: "i-lucide-trash-2",
          color: "error",
          onSelect: () => {
            confirmRemove.value = true;
          },
        },
      ],
    ];
  }
  return [
    [
      {
        label: t("convocation.editIntro"),
        icon: "i-lucide-pencil",
        onSelect: () => sheet.value?.startEditing(),
      },
      {
        label: t("convocation.print"),
        icon: "i-lucide-printer",
        to: printPath.value,
        target: "_blank",
      },
    ],
  ];
});
</script>

<template>
  <div v-if="assembly" class="flex flex-col gap-4">
    <header
      class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"
    >
      <div class="min-w-0 flex-1 space-y-1.5">
        <h2
          class="text-highlighted text-xl font-semibold text-pretty break-words sm:text-2xl"
        >
          {{ viewingSigned ? heading : t("shell.assembly.convocation") }}
        </h2>
        <div
          v-if="viewingSigned && signed"
          class="flex flex-wrap items-center gap-2"
        >
          <UBadge
            color="neutral"
            variant="outline"
            size="sm"
            icon="i-lucide-file-text"
            :label="t('document.formats.file')"
          />
          <span class="text-muted text-sm" data-testid="convocation-signed-at">
            {{
              t("convocation.signed.uploadedAt", {
                date: formatDate(signed.uploadedAt, { locale }),
              })
            }}
          </span>
        </div>
        <p v-else class="text-muted text-sm">
          {{ t("convocation.generatedNote") }}
        </p>
      </div>

      <div class="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
        <template v-if="!viewingSigned">
          <UButton
            v-if="signed"
            icon="i-lucide-file-signature"
            :label="t('convocation.signed.back')"
            @click="showGenerated = false"
          />
          <UButton
            v-else-if="assembly.can.manage"
            icon="i-lucide-file-up"
            :label="t('convocation.signed.upload')"
            :loading="uploading"
            data-testid="convocation-upload"
            @click="chooseFile"
          />
          <!-- The only action of someone who just reads it -->
          <UButton
            v-if="!assembly.can.manage"
            color="neutral"
            variant="outline"
            icon="i-lucide-printer"
            :label="t('convocation.print')"
            :to="printPath"
            target="_blank"
          />
        </template>
        <UDropdownMenu
          v-if="moreItems.length > 0"
          :items="moreItems"
          :content="{ align: 'end' }"
        >
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-ellipsis"
            trailing-icon="i-lucide-chevron-down"
            :label="t('convocation.signed.more')"
            :loading="viewingSigned && uploading"
            data-testid="convocation-more"
          />
        </UDropdownMenu>
        <input
          v-if="assembly.can.manage"
          ref="fileInput"
          type="file"
          accept="application/pdf,.pdf"
          class="sr-only"
          tabindex="-1"
          aria-hidden="true"
          data-testid="convocation-file-input"
          @change="onFileChosen"
        />
      </div>
    </header>

    <!-- The signed convocatoria, once uploaded: the viewer of any PDF -->
    <DocumentPdfViewer
      v-if="viewingSigned && signed"
      :url="signed.url"
      :title="heading"
      :description="t('convocation.signed.description')"
    />

    <template v-else>
      <UAlert
        v-if="!assembly.agendaFinalizedAt || assembly.status === 'draft'"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :title="
          assembly.status === 'draft'
            ? t('convocation.draftWarning')
            : t('convocation.provisionalWarning')
        "
      />
      <div class="bg-muted/40 border-default rounded-lg border p-3 sm:p-6">
        <ConvocationSheet ref="sheet" />
      </div>
    </template>

    <UModal
      v-model:open="confirmRemove"
      :title="t('convocation.signed.removeTitle')"
      :description="t('convocation.signed.removeDescription')"
    >
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            color="neutral"
            variant="outline"
            :label="t('common.cancel')"
            :disabled="removing"
            @click="confirmRemove = false"
          />
          <UButton
            color="error"
            icon="i-lucide-trash-2"
            :label="t('convocation.signed.removeConfirm')"
            :loading="removing"
            @click="removeSigned"
          />
        </div>
      </template>
    </UModal>

    <p class="sr-only" aria-live="polite" role="status">{{ announcement }}</p>
  </div>
</template>
