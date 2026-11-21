<script setup lang="ts">
import type {
  DocumentNoteCreateBody,
  DocumentNoteDto,
  DocumentNotesDto,
  DocumentNoteUpdateBody,
} from "~~/shared/types/api";
import { DOCUMENT_NOTE_MAX_LENGTH } from "~~/shared/utils/documentNotes";

/**
 * «Mis notas» on one document in a row's panel of the control sheet (user's
 * decision of 2026-11-21): the account's general private notes on it (not
 * the ones on a stretch of its text), written, changed and deleted here
 * through the document's own notes (GET/POST/PUT/DELETE .../notes, keyed by
 * the account). The ones on the text are only counted, with the way to
 * them in the document. Nothing shows while the document is not published
 * (`available: false`). `changed` tells the page to read the sheet's notes
 * again.
 */
const props = defineProps<{
  documentId: string;
  /** Its title, on an item with several documents; none otherwise. */
  title?: string | null;
  /** The document's page, where the notes on its text are. */
  documentPath: string;
}>();
const emit = defineEmits<{ changed: [] }>();

const { t, locale } = useI18n();
const api = useApi();
const toast = useToast();
const { apiBase } = useCurrentAssembly();

const notesUrl = computed(
  () =>
    `${apiBase.value}/documents/${encodeURIComponent(props.documentId)}/notes`,
);
const { data, refresh } = useAsyncData(
  () => `control-sheet-document-notes-${props.documentId}`,
  () => api.get<DocumentNotesDto>(notesUrl.value),
  { server: false, lazy: true, watch: [notesUrl] },
);
const available = computed(() => Boolean(data.value?.available));
const general = computed<DocumentNoteDto[]>(() =>
  (data.value?.notes ?? []).filter((note) => note.anchor === null),
);
const anchored = computed(
  () => (data.value?.notes ?? []).length - general.value.length,
);

/** The note being written (id null) or changed; null when the form is closed. */
const editing = ref<{ id: string | null; updatedAt: string | null } | null>(
  null,
);
const draft = ref("");
const saving = ref(false);
/** The note whose delete was asked once: a second press deletes it. */
const confirmingDelete = ref<string | null>(null);
const fieldId = useId();

watch(
  () => props.documentId,
  () => {
    editing.value = null;
    confirmingDelete.value = null;
  },
);

function startNew(): void {
  editing.value = { id: null, updatedAt: null };
  draft.value = "";
}

function startEdit(note: DocumentNoteDto): void {
  editing.value = { id: note.id, updatedAt: note.updatedAt };
  draft.value = note.body;
}

function cancel(): void {
  editing.value = null;
  draft.value = "";
}

const formatWhen = (value: string) =>
  formatMoment(value, { locale: locale.value }).text;

async function save(): Promise<void> {
  const target = editing.value;
  const text = draft.value.trim();
  if (!target || !text || saving.value) return;
  saving.value = true;
  try {
    if (target.id === null) {
      await api.send(notesUrl.value, {
        method: "POST",
        body: { anchor: null, body: text } satisfies DocumentNoteCreateBody,
      });
    } else {
      await api.send(`${notesUrl.value}/${encodeURIComponent(target.id)}`, {
        method: "PUT",
        body: {
          body: text,
          updatedAt: target.updatedAt!,
        } satisfies DocumentNoteUpdateBody,
      });
    }
    toast.add({
      title: t("notes.saved"),
      color: "success",
      icon: "i-lucide-sticky-note",
    });
    cancel();
    await refresh();
    emit("changed");
  } catch (error) {
    api.notifyError(error, "notes.saveError");
  } finally {
    saving.value = false;
  }
}

async function remove(note: DocumentNoteDto): Promise<void> {
  if (confirmingDelete.value !== note.id) {
    confirmingDelete.value = note.id;
    return;
  }
  confirmingDelete.value = null;
  try {
    await api.send(`${notesUrl.value}/${encodeURIComponent(note.id)}`, {
      method: "DELETE",
    });
    toast.add({
      title: t("notes.deleted"),
      color: "success",
      icon: "i-lucide-trash-2",
    });
    await refresh();
    emit("changed");
  } catch (error) {
    api.notifyError(error, "notes.deleteError");
  }
}
</script>

<template>
  <div v-if="available" class="flex flex-col gap-2">
    <div class="flex items-center justify-between gap-2">
      <p v-if="title" class="text-default min-w-0 truncate text-sm font-medium">
        {{ title }}
      </p>
      <UButton
        v-if="!editing"
        color="neutral"
        variant="ghost"
        size="xs"
        icon="i-lucide-plus"
        class="ms-auto"
        :label="t('notes.addGeneral')"
        @click="startNew"
      />
    </div>

    <ul v-if="general.length > 0" class="flex flex-col gap-2">
      <li
        v-for="note in general"
        :key="note.id"
        class="border-default rounded-md border px-3 py-2"
      >
        <p class="text-default text-sm whitespace-pre-line">{{ note.body }}</p>
        <div class="mt-1 flex flex-wrap items-center justify-between gap-2">
          <span class="text-muted text-xs">{{
            formatWhen(note.updatedAt)
          }}</span>
          <span class="flex items-center gap-1">
            <UButton
              color="neutral"
              variant="ghost"
              size="xs"
              icon="i-lucide-pencil"
              :label="t('amendment.notes.edit')"
              :disabled="Boolean(editing)"
              @click="startEdit(note)"
            />
            <UButton
              :color="confirmingDelete === note.id ? 'error' : 'neutral'"
              variant="ghost"
              size="xs"
              icon="i-lucide-trash-2"
              :label="
                confirmingDelete === note.id
                  ? t('notes.deleteConfirm')
                  : t('amendment.notes.delete')
              "
              @click="remove(note)"
            />
          </span>
        </div>
      </li>
    </ul>
    <p v-else-if="!editing" class="text-muted text-sm">
      {{ t("notes.empty") }}
    </p>

    <ULink
      v-if="anchored > 0"
      :to="documentPath"
      class="text-muted hover:text-default inline-flex items-center gap-1 self-start text-xs underline-offset-2 hover:underline"
    >
      <UIcon
        name="i-lucide-file-text"
        class="size-3.5 shrink-0"
        aria-hidden="true"
      />
      {{ t("controlSheet.ownNotes.anchored", { count: anchored }, anchored) }}
    </ULink>

    <form
      v-if="editing"
      class="flex flex-col gap-3"
      @submit.prevent="save"
      @keydown.esc.stop="cancel"
    >
      <UFormField :label="t('notes.dialog.label')" :name="fieldId">
        <UTextarea
          :id="fieldId"
          v-model="draft"
          :placeholder="t('notes.dialog.placeholder')"
          :maxlength="DOCUMENT_NOTE_MAX_LENGTH"
          autoresize
          :rows="3"
          class="w-full"
          autofocus
        />
      </UFormField>
      <div class="flex flex-wrap justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          :label="t('common.cancel')"
          @click="cancel"
        />
        <UButton
          type="submit"
          size="sm"
          :loading="saving"
          :disabled="draft.trim() === ''"
          :label="t('notes.dialog.save')"
        />
      </div>
    </form>
  </div>
</template>
