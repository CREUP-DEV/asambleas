<script setup lang="ts">
import type { DocumentDto } from "~~/shared/types/api";
import type { Block } from "~~/shared/types/content";
import { formatTime } from "~/utils/format";

/**
 * The working draft of a structured document: block editor, explicit save
 * (PUT .../content with the stored `contentHash` as `baseHash`), word and
 * paragraph counts, DOCX import and save-conflict recovery.
 *
 * The editor works on a local copy of the blocks. Server copies are adopted
 * only when there is nothing unsaved, compared by `contentHash` (jsonb
 * reorders keys, so blocks themselves are never compared with the server).
 *
 * While the stored draft is empty, uploading a Word file is offered as the
 * main way in, above the editor (writing directly stays possible).
 *
 * Emits `saved` with the updated document (store it) and `stale` when the
 * document must be refetched (save conflict, text frozen meanwhile).
 */
const props = withDefaults(
  defineProps<{
    document: DocumentDto;
    /** "/api/assemblies/{assembly}/documents/{document}" (slugs or ids). */
    documentApi: string;
    disabled?: boolean;
    /**
     * Id of a heading outside that already names this section (a numbered
     * step): the editor then shows no heading of its own.
     */
    labelledby?: string;
  }>(),
  { disabled: false, labelledby: undefined },
);

const emit = defineEmits<{
  saved: [document: DocumentDto];
  stale: [];
}>();

/** True while the draft has unsaved changes. */
const dirtyModel = defineModel<boolean>("dirty", { default: false });
/** Blocks in the draft as edited (saved or not). */
const blockCountModel = defineModel<number>("blockCount", { default: 0 });

const { t, locale } = useI18n();
const toast = useToast();
const { send, notifyError, isConflict } = useApi();

interface EditorHandle {
  flush: () => void;
  focus: () => void;
}
const editor = useTemplateRef<EditorHandle>("editor");

/** Order-stable serialization, so key order never reads as a change. */
function canonical(blocks: Block[]): string {
  return JSON.stringify(
    blocks.map((block) => [
      block.id,
      block.type,
      block.level ?? null,
      block.list ?? null,
      block.marker ?? null,
      block.start ?? null,
      block.cell
        ? [
            block.cell.table,
            block.cell.row,
            block.cell.cell,
            block.cell.header ?? false,
            block.cell.colspan ?? 1,
            block.cell.rowspan ?? 1,
          ]
        : null,
      block.text,
      block.marks.map((mark) => [
        mark.type,
        mark.from,
        mark.to,
        mark.href ?? null,
      ]),
    ]),
  );
}

function cloneBlocks(blocks: Block[]): Block[] {
  return blocks.map((block) => ({
    ...block,
    marks: block.marks.map((mark) => ({ ...mark })),
  }));
}

const serverBlocks = () => props.document.workingVersion?.blocks ?? [];

const blocks = ref<Block[]>(cloneBlocks(serverBlocks()));
const baseHash = ref(props.document.workingVersion?.contentHash ?? "");
const savedKey = ref(canonical(blocks.value));

const unsaved = computed(() => canonical(blocks.value) !== savedKey.value);
watch(unsaved, (value) => (dirtyModel.value = value), { immediate: true });
watch(
  () => blocks.value.length,
  (count) => (blockCountModel.value = count),
  { immediate: true },
);

const saving = ref(false);
const lastSavedAt = ref<Date | null>(null);
const saveFailed = ref(false);
/** The user's text after a conflict, while they decide what to do. */
const recovery = shallowRef<Block[] | null>(null);
/** Someone else saved while this draft had unsaved changes. */
const remoteChanged = ref(false);
/** Adopt the next server copy even with unsaved changes (after a conflict). */
let adoptNext = false;

function adoptServerCopy(): void {
  blocks.value = cloneBlocks(serverBlocks());
  baseHash.value = props.document.workingVersion?.contentHash ?? "";
  savedKey.value = canonical(blocks.value);
  remoteChanged.value = false;
}

watch(
  () => props.document.workingVersion?.contentHash,
  (hash) => {
    if (!hash || hash === baseHash.value) return;
    if (adoptNext || !unsaved.value) {
      adoptNext = false;
      adoptServerCopy();
    } else {
      remoteChanged.value = true;
    }
  },
);

let inflight: Promise<boolean> | null = null;

/**
 * Saves the draft if it has changes. Resolves to true only when everything
 * typed so far is stored: a call during a running save waits for it and
 * then saves what was typed meanwhile.
 */
function save(): Promise<boolean> {
  editor.value?.flush();
  if (inflight) {
    return inflight.then((ok) => (ok && unsaved.value ? save() : ok));
  }
  if (!unsaved.value) return Promise.resolve(true);
  inflight = doSave().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function doSave(): Promise<boolean> {
  saving.value = true;
  saveFailed.value = false;
  const snapshot = blocks.value;
  const key = canonical(snapshot);
  try {
    const updated = await send<DocumentDto>(`${props.documentApi}/content`, {
      method: "PUT",
      body: { blocks: snapshot, baseHash: baseHash.value },
    });
    baseHash.value = updated.workingVersion?.contentHash ?? baseHash.value;
    savedKey.value = key;
    lastSavedAt.value = new Date();
    remoteChanged.value = false;
    emit("saved", updated);
    return true;
  } catch (error) {
    saveFailed.value = true;
    // 409: someone saved first (stale baseHash) or the text was frozen
    // meanwhile. Either way keep the user's text and reload; a frozen text
    // also turns can.edit off: the page hides the editor (managers) or
    // moves to the workspace (presenters).
    if (isConflict(error)) {
      recovery.value = cloneBlocks(snapshot);
      adoptNext = true;
      toast.add({
        id: "document-save-conflict",
        title: t("document.authoring.conflictTitle"),
        description: t("document.authoring.conflictDescription"),
        color: "warning",
        icon: "i-lucide-refresh-ccw",
      });
      emit("stale");
    } else {
      notifyError(error, "document.authoring.saveError");
    }
    return false;
  } finally {
    saving.value = false;
  }
}

function restoreRecovery(): void {
  if (!recovery.value) return;
  // Saving now replaces the stored copy, since baseHash is the new one.
  blocks.value = cloneBlocks(recovery.value);
  recovery.value = null;
  remoteChanged.value = false;
  editor.value?.focus();
}

function discardRecovery(): void {
  recovery.value = null;
}

/** Keep the user's text aside and load the copy someone else saved. */
function loadRemote(): void {
  editor.value?.flush();
  recovery.value = cloneBlocks(blocks.value);
  adoptServerCopy();
}

async function onImport(imported: Block[]): Promise<void> {
  // Settle pending keystrokes first, so they cannot overwrite the import.
  editor.value?.flush();
  blocks.value = cloneBlocks(imported);
  await nextTick();
  if (await save()) {
    toast.add({
      title: t("document.authoring.imported"),
      color: "success",
      icon: "i-lucide-check",
    });
  }
}

defineShortcuts({
  meta_s: {
    usingInput: true,
    handler: () => {
      if (!props.disabled) void save();
    },
  },
});

const statusText = computed(() => {
  if (saving.value) return t("document.authoring.saving");
  if (saveFailed.value && unsaved.value)
    return t("document.authoring.notSaved");
  if (unsaved.value) return t("document.authoring.unsaved");
  if (lastSavedAt.value)
    return t("document.authoring.savedAt", {
      time: formatTime(lastSavedAt.value, { locale: locale.value }),
    });
  return t("document.authoring.upToDate");
});

const headingId = useId();

/**
 * Nothing stored yet: offer the Word upload as the main way in. Based on the
 * stored copy, so the card does not vanish (and move the editor) while the
 * user types; it goes once the first text is saved.
 */
const storedEmpty = computed(
  () => (props.document.workingVersion?.blocks.length ?? 0) === 0,
);
const showWordCard = computed(() => storedEmpty.value && !recovery.value);

defineExpose({
  save,
  flush: () => editor.value?.flush(),
  focus: () => editor.value?.focus(),
  blocks: computed(() => blocks.value),
  dirty: unsaved,
});
</script>

<template>
  <section class="space-y-3" :aria-labelledby="labelledby ?? headingId">
    <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <div class="min-w-0">
        <h3
          v-if="!labelledby"
          :id="headingId"
          class="text-highlighted text-base font-semibold"
        >
          {{ t("document.authoring.text") }}
        </h3>
        <DocumentContentStats :blocks="blocks" />
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <DocumentDocxImport
          v-if="!showWordCard"
          :document-api="documentApi"
          :current-count="blocks.length"
          :unsaved="unsaved"
          :disabled="disabled || saving"
          @import="onImport"
        />
        <UTooltip
          :text="t('document.authoring.saveShortcut')"
          :kbds="['meta', 's']"
        >
          <!-- Secondary: sending or publishing saves the text first -->
          <UButton
            icon="i-lucide-save"
            size="sm"
            color="neutral"
            variant="outline"
            :label="t('document.authoring.save')"
            :loading="saving"
            :disabled="disabled || !unsaved"
            @click="save"
          />
        </UTooltip>
      </div>
    </div>

    <p
      class="text-xs"
      :class="unsaved ? 'text-warning' : 'text-muted'"
      role="status"
      aria-live="polite"
    >
      {{ statusText }}
    </p>

    <UAlert
      v-if="remoteChanged && !recovery"
      color="warning"
      variant="subtle"
      icon="i-lucide-users"
      :title="t('document.authoring.remoteTitle')"
      :description="t('document.authoring.remoteDescription')"
      :actions="[
        {
          label: t('document.authoring.loadRemote'),
          color: 'warning',
          variant: 'solid',
          size: 'sm',
          onClick: loadRemote,
        },
      ]"
      role="alert"
    />

    <div
      v-if="showWordCard"
      class="border-default bg-elevated/40 flex flex-col items-center gap-3 rounded-lg border border-dashed p-4 text-center sm:p-6"
      data-testid="word-upload-card"
    >
      <UIcon
        name="i-lucide-file-type"
        class="text-primary size-8"
        aria-hidden="true"
      />
      <div class="space-y-1">
        <p class="text-highlighted font-medium">
          {{ t("document.authoring.wordCard.title") }}
        </p>
        <p class="text-muted max-w-prose text-sm">
          {{ t("document.authoring.wordCard.description") }}
        </p>
      </div>
      <DocumentDocxImport
        prominent
        :document-api="documentApi"
        :current-count="blocks.length"
        :unsaved="unsaved"
        :disabled="disabled || saving"
        @import="onImport"
      />
      <p class="text-muted text-xs">
        {{ t("document.authoring.wordCard.orWrite") }}
      </p>
    </div>

    <DocumentRecoveryPanel
      v-if="recovery"
      :blocks="recovery"
      @restore="restoreRecovery"
      @discard="discardRecovery"
    />

    <ClientOnly>
      <ContentBlockEditor
        ref="editor"
        v-model="blocks"
        :editable="!disabled"
        :label="t('document.authoring.editorLabel')"
        :placeholder="t('document.authoring.editorPlaceholder')"
      />
      <template #fallback>
        <div class="space-y-2" aria-hidden="true">
          <USkeleton class="h-10 w-full" />
          <USkeleton class="h-96 w-full" />
        </div>
      </template>
    </ClientOnly>
  </section>
</template>
