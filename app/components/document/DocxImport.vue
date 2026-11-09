<script setup lang="ts">
import type { DocxImportDto } from "~~/shared/types/api";
import type { Block } from "~~/shared/types/content";
import {
  REGULATION_DOCUMENT_KINDS,
  type DocumentKind,
} from "~~/shared/constants/domain";

/**
 * DOCX import for the working draft: pick a .docx, the server converts it
 * (POST .../import, nothing is stored), the user reviews the text and the
 * warnings, and confirming emits `import` with the blocks to use as the new
 * draft. The parent replaces and saves. `prominent` turns the button into the
 * main call to action of an empty draft.
 */
const props = withDefaults(
  defineProps<{
    /** "/api/assemblies/{assembly}/documents/{document}" (slugs or ids). */
    documentApi: string;
    /** Blocks in the current draft, to warn that they will be replaced. */
    currentCount?: number;
    /** The draft has unsaved changes. */
    unsaved?: boolean;
    disabled?: boolean;
    /** The main way in: a large primary button ("Subir archivo de Word"). */
    prominent?: boolean;
    /** The document's title, to spot the template header that repeats it. */
    documentTitle?: string;
    /** The document's kind: in a reform the approval line is content. */
    documentKind?: DocumentKind | null;
  }>(),
  {
    currentCount: 0,
    unsaved: false,
    disabled: false,
    prominent: false,
    documentTitle: "",
    documentKind: null,
  },
);

const emit = defineEmits<{ import: [blocks: Block[]] }>();

const { t } = useI18n();
const toast = useToast();
const { send, notifyError, errorStatus } = useApi();

const DOCX_MAX_BYTES = 15 * 1024 * 1024;
const DOCX_ACCEPT =
  ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const uploading = ref(false);
const fileName = ref("");
const result = shallowRef<DocxImportDto | null>(null);
const open = ref(false);

const dialog = useFileDialog({
  accept: DOCX_ACCEPT,
  multiple: false,
  reset: true,
});

dialog.onChange((files) => {
  const file = files?.[0];
  if (file) void upload(file);
});

function fail(key: string, titleKey = "document.import.error"): void {
  toast.add({
    title: t(titleKey),
    description: t(key),
    color: "error",
    icon: "i-lucide-circle-alert",
  });
}

/**
 * The reason code the server attached to a refusal (`createError({ data })`
 * reaches the client at `error.data.data`), e.g. `"empty"` for a file with
 * no usable text, which shares its 422 with "exceeds the content limits".
 */
function errorReason(error: unknown): unknown {
  if (!error || typeof error !== "object") return undefined;
  return (error as { data?: { data?: { reason?: unknown } } | null }).data?.data
    ?.reason;
}

async function upload(file: File): Promise<void> {
  if (!/\.docx$/i.test(file.name)) {
    fail("document.import.invalidFile");
    return;
  }
  if (file.size > DOCX_MAX_BYTES) {
    fail("document.import.tooLarge");
    return;
  }
  uploading.value = true;
  fileName.value = file.name;
  try {
    const body = new FormData();
    body.append("file", file, file.name);
    result.value = await send<DocxImportDto>(`${props.documentApi}/import`, {
      body,
    });
    open.value = true;
  } catch (error) {
    const status = errorStatus(error);
    if (status === 415) fail("document.import.invalidFile");
    // Blank, or only images (which are dropped): splitting it cannot help.
    else if (status === 422 && errorReason(error) === "empty")
      fail("document.import.emptyDescription", "document.import.empty");
    // The file is within 15 MB (checked above): the server refused what it
    // expands to (size, markup or number of paragraphs).
    else if (status === 413 || status === 422)
      fail("document.import.tooComplex");
    else if (status === 429) fail("document.import.busy");
    else notifyError(error, "document.import.error");
  } finally {
    uploading.value = false;
  }
}

const imported = computed(() => result.value?.blocks ?? []);

/**
 * Leading lines of CREUP's template (the title again, "Aprobada en la [NUM]
 * Asamblea…"), which the platform already shows: dropped unless the user
 * keeps them.
 */
const headerLength = computed(() =>
  templateHeaderLength(imported.value, props.documentTitle),
);
const headerLines = computed(() =>
  imported.value.slice(0, headerLength.value).map((block) => block.text),
);
/**
 * Dropped by default, except in the Estatutos and the regulations: there the
 * approval and amendment history line belongs to the text and may be
 * amended ("Modificado parcialmente en la 76.ª AGO…").
 */
const dropByDefault = computed(
  () =>
    !props.documentKind ||
    !REGULATION_DOCUMENT_KINDS.includes(props.documentKind),
);
const dropHeader = ref(dropByDefault.value);

const blocks = computed(() =>
  dropHeader.value && headerLength.value > 0
    ? imported.value.slice(headerLength.value)
    : imported.value,
);
/** Paragraphs and headings: images are not counted as either. */
const textBlocks = computed(
  () => blocks.value.filter((block) => block.type !== "image").length,
);
const words = computed(() =>
  blocks.value.reduce(
    (total, block) =>
      total + block.text.split(/\s+/).filter((word) => word.length > 0).length,
    0,
  ),
);

const WARNING_ICONS: Record<DocxImportDto["warnings"][number], string> = {
  tracked_changes: "i-lucide-git-compare",
  comments: "i-lucide-message-square-warning",
  images_dropped: "i-lucide-image-off",
  images_in_tables: "i-lucide-image-minus",
  images_without_alt: "i-lucide-image",
  tables_flattened: "i-lucide-table",
  highlight: "i-lucide-highlighter",
};

/** Nothing to replace: the imported text simply becomes the draft. */
const replacesNothing = computed(
  () => props.currentCount === 0 && !props.unsaved,
);

function confirm(): void {
  if (blocks.value.length === 0) return;
  emit("import", blocks.value);
  open.value = false;
}

watch(open, (isOpen) => {
  if (!isOpen) result.value = null;
  else dropHeader.value = dropByDefault.value;
});
</script>

<template>
  <div class="contents">
    <UButton
      icon="i-lucide-file-up"
      :color="prominent ? 'primary' : 'neutral'"
      :variant="prominent ? 'solid' : 'outline'"
      :size="prominent ? 'lg' : 'sm'"
      :label="
        prominent
          ? t('document.import.uploadWord')
          : t('document.import.button')
      "
      :loading="uploading"
      :disabled="disabled || uploading"
      @click="dialog.open()"
    />
    <span class="sr-only" aria-live="polite">
      {{ uploading ? t("document.import.uploading", { name: fileName }) : "" }}
    </span>

    <UModal
      v-model:open="open"
      :title="t('document.import.title')"
      :description="t('document.import.description', { name: fileName })"
      :ui="{ content: 'sm:max-w-3xl', footer: 'justify-end gap-2' }"
    >
      <template #body>
        <div class="space-y-3">
          <UAlert
            v-for="warning in result?.warnings ?? []"
            :key="warning"
            color="warning"
            variant="subtle"
            :icon="WARNING_ICONS[warning]"
            :title="t(`document.import.warnings.${warning}`)"
          />

          <UAlert
            v-if="currentCount > 0 || unsaved"
            color="neutral"
            variant="subtle"
            icon="i-lucide-replace"
            :title="
              t(
                'document.import.replaces',
                { count: currentCount },
                currentCount,
              )
            "
            :description="
              unsaved ? t('document.import.unsavedLost') : undefined
            "
          />

          <div
            v-if="headerLength > 0"
            class="border-default rounded-md border p-3"
          >
            <UCheckbox
              v-model="dropHeader"
              :label="t('document.import.templateHeader.label')"
              :description="
                t(
                  'document.import.templateHeader.description',
                  { count: headerLength },
                  headerLength,
                )
              "
            />
            <ul class="text-muted mt-2 ms-7 space-y-1 text-sm">
              <li
                v-for="(line, index) in headerLines"
                :key="index"
                :class="{ 'line-through': dropHeader }"
              >
                {{ line }}
              </li>
            </ul>
          </div>

          <p class="text-muted text-sm">
            {{
              t("document.import.stats", {
                blocks: textBlocks,
                words,
              })
            }}
          </p>

          <div
            v-if="blocks.length > 0"
            class="border-default bg-default max-h-[55vh] overflow-y-auto rounded-md border p-4 sm:p-6"
            tabindex="0"
            role="region"
            :aria-label="t('document.import.preview')"
          >
            <ContentView :blocks="blocks" />
          </div>
          <CommonEmptyState
            v-else
            icon="i-lucide-file-x"
            :title="t('document.import.empty')"
            :description="t('document.import.emptyDescription')"
          />
        </div>
      </template>

      <template #footer="{ close }">
        <UButton
          color="neutral"
          variant="ghost"
          :label="t('document.import.cancel')"
          @click="close"
        />
        <UButton
          icon="i-lucide-check"
          :label="
            replacesNothing
              ? t('document.import.useText')
              : t('document.import.confirm')
          "
          :disabled="blocks.length === 0"
          @click="confirm"
        />
      </template>
    </UModal>
  </div>
</template>
