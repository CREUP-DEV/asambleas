<script setup lang="ts">
import type {
  AmendmentDto,
  AmendmentNoteDto,
  AmendmentNotesDto,
} from "~~/shared/types/api";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { useSheetObservations } from "~/composables/document/useSheetObservations";
import { AMENDMENT_NOTE_MAX_LENGTH } from "~~/shared/utils/amendmentNotes";
import { CONTROL_SHEET_OBSERVATIONS_MAX_LENGTH } from "~~/shared/utils/schemas/controlSheet";

/**
 * The account's private notes on an amendment, about the whole of it
 * (docs/design.md, "Private notes"): listed under its detail, written,
 * changed and deleted here. An account that edits the control sheet may
 * send a new note to the amendment's observations in the sheet instead
 * (user's decision of 2026-11-17): it is added after what the sheet already
 * says there, never in its place, and every reader of the sheet reads it.
 * Whoever reads the sheet also reads here what it says about the amendment
 * (useSheetObservations, provided by the document page).
 */
const props = defineProps<{
  amendment: AmendmentDto;
  /** Base URL of the document's amendments: .../amendments. */
  amendmentsUrl: string;
}>();

const { t, locale } = useI18n();
const api = useApi();
const toast = useToast();
const { can } = useMe();
const sheet = useSheetObservations();
/** What the control sheet says about this amendment, for its readers. */
const sheetObservation = computed(
  () => sheet?.amendment(props.amendment.id) ?? null,
);
const { apiBase } = useCurrentAssembly();

const notesUrl = computed(
  () =>
    `${props.amendmentsUrl}/${encodeURIComponent(props.amendment.id)}/notes`,
);

const { data, refresh } = useAsyncData(
  () => `amendment-notes-${props.amendment.id}`,
  () => api.get<AmendmentNotesDto>(notesUrl.value),
  { server: false, lazy: true, watch: [notesUrl] },
);
const notes = computed<AmendmentNoteDto[]>(() => data.value?.notes ?? []);
const available = computed(() => Boolean(data.value?.available));

/** Whoever edits the control sheet may write there instead. */
const sendsToSheet = computed(() => can(PERMISSION_KEYS.CONTROL_SHEET_EDIT));

type Destination = "note" | "sheet";

/** The note being written or changed; null when the form is closed. */
const editing = ref<{ id: string | null; updatedAt: string | null } | null>(
  null,
);
const draft = ref("");
const destination = ref<Destination>("note");
const saving = ref(false);
/** The note whose delete was asked once: a second press deletes it. */
const confirmingDelete = ref<string | null>(null);

watch(
  () => props.amendment.id,
  () => {
    editing.value = null;
    confirmingDelete.value = null;
  },
);

const headingId = useId();
const fieldId = useId();

const maxLength = computed(() =>
  destination.value === "sheet"
    ? CONTROL_SHEET_OBSERVATIONS_MAX_LENGTH
    : AMENDMENT_NOTE_MAX_LENGTH,
);

const destinationItems = computed(() => [
  {
    value: "note",
    label: t("amendment.notes.destination.note"),
    description: t("notes.private"),
  },
  {
    value: "sheet",
    label: t("amendment.notes.destination.sheet"),
    description: t("amendment.notes.destination.sheetHint"),
  },
]);

function startNew(): void {
  editing.value = { id: null, updatedAt: null };
  draft.value = "";
  destination.value = "note";
}

function startEdit(note: AmendmentNoteDto): void {
  editing.value = { id: note.id, updatedAt: note.updatedAt };
  draft.value = note.body;
  destination.value = "note";
}

function cancel(): void {
  editing.value = null;
  draft.value = "";
}

function formatWhen(value: string): string {
  return formatMoment(value, { locale: locale.value }).text;
}

async function save(): Promise<void> {
  const target = editing.value;
  const text = draft.value.trim();
  if (!target || !text || saving.value) return;
  saving.value = true;
  try {
    if (target.id === null && destination.value === "sheet") {
      await api.send(
        `${apiBase.value}/control-sheet/amendments/${encodeURIComponent(props.amendment.id)}`,
        { method: "PATCH", body: { observationsAppend: text } },
      );
      toast.add({
        title: t("amendment.notes.sheetSaved"),
        color: "success",
        icon: "i-lucide-clipboard-check",
      });
      void sheet?.refresh();
    } else if (target.id === null) {
      await api.send(notesUrl.value, { method: "POST", body: { body: text } });
      toast.add({
        title: t("notes.saved"),
        color: "success",
        icon: "i-lucide-sticky-note",
      });
    } else {
      await api.send(`${notesUrl.value}/${encodeURIComponent(target.id)}`, {
        method: "PUT",
        body: { body: text, updatedAt: target.updatedAt },
      });
      toast.add({
        title: t("notes.saved"),
        color: "success",
        icon: "i-lucide-sticky-note",
      });
    }
    cancel();
    await refresh();
  } catch (error) {
    api.notifyError(
      error,
      destination.value === "sheet"
        ? "amendment.notes.sheetError"
        : "notes.saveError",
    );
  } finally {
    saving.value = false;
  }
}

async function remove(note: AmendmentNoteDto): Promise<void> {
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
  } catch (error) {
    api.notifyError(error, "notes.deleteError");
  }
}
</script>

<template>
  <section
    v-if="available"
    class="flex flex-col gap-2"
    :aria-labelledby="headingId"
    data-testid="amendment-notes"
  >
    <div class="flex items-center justify-between gap-2">
      <h3 :id="headingId" class="text-highlighted text-sm font-semibold">
        {{ t("notes.title") }}
      </h3>
      <UButton
        v-if="!editing"
        color="neutral"
        variant="ghost"
        size="xs"
        icon="i-lucide-plus"
        :label="t('amendment.notes.add')"
        @click="startNew"
      />
    </div>
    <p class="text-muted text-xs">{{ t("notes.private") }}</p>

    <ul v-if="notes.length > 0" class="flex flex-col gap-2">
      <li
        v-for="note in notes"
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
      {{ t("amendment.notes.empty") }}
    </p>

    <!-- What the control sheet says about it, for whoever reads the sheet. -->
    <div
      v-if="sheetObservation"
      class="border-default flex flex-col gap-1 rounded-md border border-dashed px-3 py-2"
      data-testid="amendment-sheet-observation"
    >
      <p class="text-muted flex items-center gap-1.5 text-xs font-semibold">
        <UIcon
          name="i-lucide-clipboard-list"
          class="size-3.5 shrink-0"
          aria-hidden="true"
        />
        {{ t("amendment.notes.sheetTitle") }}
      </p>
      <p class="text-default text-sm whitespace-pre-line">
        {{ sheetObservation.text }}
      </p>
      <p v-if="sheetObservation.edited" class="text-muted text-xs">
        {{
          sheetObservation.edited.by
            ? t("amendment.notes.sheetEdited", {
                name: sheetObservation.edited.by,
                when: formatWhen(sheetObservation.edited.at),
              })
            : formatWhen(sheetObservation.edited.at)
        }}
      </p>
    </div>

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
          :maxlength="maxLength"
          autoresize
          :rows="3"
          class="w-full"
          autofocus
        />
      </UFormField>
      <URadioGroup
        v-if="sendsToSheet && editing.id === null"
        v-model="destination"
        :legend="t('amendment.notes.destination.legend')"
        :items="destinationItems"
        size="sm"
      />
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
          :label="
            destination === 'sheet' && editing.id === null
              ? t('amendment.notes.destination.save')
              : t('notes.dialog.save')
          "
        />
      </div>
    </form>
  </section>
</template>
