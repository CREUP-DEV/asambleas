<script setup lang="ts">
import type {
  AmendmentDto,
  CorrectionBody,
  UndoValidationBody,
} from "~~/shared/types/api";
import { CORRECTION_NOTE_MAX_LENGTH } from "~~/shared/utils/schemas/document";

/**
 * The Secretaría takes back the validation of an amendment it validated,
 * published or not, while it is undecided (AmendmentDto.can.unvalidate):
 * - "Deshacer la validación" (POST .../unvalidate): it goes back to
 *   "Por revisar" as it is. It asks first when it is public (everyone stops
 *   seeing it) or its presenter answered (the answer goes back to pending);
 * - "Devolver para corregir" (POST .../correction): back to its authors as
 *   a draft with a note saying why it cannot go as it is. They may fix it
 *   and present it again (same number and code, on time if it was), or
 *   leave it: a draft never counts. The form says what else happens.
 * One line says where it stands; the parent shows it only while it can,
 * and takes the focus back once it is gone (`settled`).
 */
const props = defineProps<{
  amendment: AmendmentDto;
  /** URL of the amendment: .../amendments/{id}. */
  url: string;
}>();

const emit = defineEmits<{
  /** Back to review: the amendment as it is now. */
  updated: [amendment: AmendmentDto];
  /** Back to its authors as a draft. */
  corrected: [amendment: AmendmentDto];
  /** Something moved meanwhile (409): refetch. */
  conflict: [];
  /** Done and gone: the parent should take the focus. */
  settled: [];
}>();

const { t } = useI18n();
const api = useApi();
const toast = useToast();

const busy = ref<"undo" | "correction" | null>(null);
const confirmOpen = ref(false);
const asking = ref(false);
const note = ref("");
const noteAttempted = ref(false);
const noteInput = useTemplateRef<{ textareaRef?: HTMLTextAreaElement }>(
  "noteInput",
);
const askButton = useTemplateRef<{ $el?: HTMLElement }>("askButton");

const published = computed(() => props.amendment.publishedAt !== null);
/** Its presenter answered: going back clears the answer. */
const answered = computed(
  () =>
    props.amendment.position !== null &&
    props.amendment.position.position !== "pending",
);
/** What else going back does, for the form and the confirmation. */
const consequences = computed(() =>
  [
    published.value ? t("amendment.validationUndo.hides") : null,
    answered.value ? t("amendment.validationUndo.clearsAnswer") : null,
  ].filter((line): line is string => line !== null),
);
const noteMissing = computed(() => !note.value.trim());

watch(
  () => props.amendment.id,
  () => {
    asking.value = false;
    note.value = "";
    noteAttempted.value = false;
    confirmOpen.value = false;
  },
);

function failed(error: unknown, key: string): void {
  api.notifyError(error, key);
  if (api.isConflict(error) || api.errorStatus(error) === 404) {
    emit("conflict");
  }
}

function startUndo(): void {
  // Public, or answered: it asks first.
  if (consequences.value.length > 0) confirmOpen.value = true;
  else void undo();
}

async function undo(): Promise<void> {
  if (busy.value) return;
  busy.value = "undo";
  try {
    const body: UndoValidationBody = { updatedAt: props.amendment.updatedAt };
    const updated = await api.send<AmendmentDto>(`${props.url}/unvalidate`, {
      body: { ...body },
    });
    confirmOpen.value = false;
    toast.add({
      title: t("amendment.validationUndo.undone"),
      description: published.value
        ? t("amendment.validationUndo.undoneHidden")
        : undefined,
      color: "success",
      icon: "i-lucide-badge-x",
    });
    emit("updated", updated);
    emit("settled");
  } catch (error) {
    confirmOpen.value = false;
    failed(error, "amendment.validationUndo.failed");
  } finally {
    busy.value = null;
  }
}

function startCorrection(): void {
  asking.value = true;
  noteAttempted.value = false;
  void nextTick(() => noteInput.value?.textareaRef?.focus());
}

function cancelCorrection(): void {
  asking.value = false;
  void nextTick(() => askButton.value?.$el?.focus());
}

async function sendCorrection(): Promise<void> {
  noteAttempted.value = true;
  if (noteMissing.value) {
    noteInput.value?.textareaRef?.focus();
    return;
  }
  if (busy.value) return;
  busy.value = "correction";
  try {
    const body: CorrectionBody = {
      note: note.value.trim(),
      updatedAt: props.amendment.updatedAt,
    };
    const updated = await api.send<AmendmentDto>(`${props.url}/correction`, {
      body: { ...body },
    });
    asking.value = false;
    note.value = "";
    toast.add({
      title: t("amendment.review.toasts.correctionSent"),
      description: t("amendment.review.toasts.correctionSentDescription"),
      color: "success",
      icon: "i-lucide-undo-2",
    });
    emit("corrected", updated);
  } catch (error) {
    failed(error, "amendment.review.toasts.correctionFailed");
  } finally {
    busy.value = null;
  }
}
</script>

<template>
  <section
    class="border-default flex flex-col gap-3 rounded-lg border p-3 sm:p-4"
    :aria-label="t('amendment.validationUndo.label')"
  >
    <p class="text-default text-sm">
      {{
        published
          ? t("amendment.validationUndo.statePublished")
          : t("amendment.validationUndo.stateValidated")
      }}
    </p>

    <form
      v-if="asking"
      class="flex flex-col gap-2"
      novalidate
      @submit.prevent="sendCorrection"
    >
      <UFormField
        :label="t('amendment.review.correctionNote')"
        :help="t('amendment.validationUndo.correctionHelp')"
        :error="
          noteAttempted && noteMissing
            ? t('amendment.review.correctionRequired')
            : undefined
        "
        required
      >
        <template v-if="consequences.length > 0" #description>
          <span class="text-default">{{ consequences.join(" ") }}</span>
        </template>
        <UTextarea
          ref="noteInput"
          v-model="note"
          :rows="3"
          autoresize
          :maxrows="10"
          :maxlength="CORRECTION_NOTE_MAX_LENGTH"
          class="w-full"
          :placeholder="t('amendment.review.correctionPlaceholder')"
        />
      </UFormField>
      <div class="flex flex-wrap items-center gap-2">
        <UButton
          type="submit"
          icon="i-lucide-send"
          :loading="busy === 'correction'"
          :disabled="busy !== null"
          :label="t('amendment.review.actions.sendCorrection')"
        />
        <UButton
          color="neutral"
          variant="ghost"
          :disabled="busy !== null"
          :label="t('amendment.actions.cancel')"
          @click="cancelCorrection"
        />
      </div>
    </form>

    <div v-else class="flex flex-wrap items-center gap-2">
      <UButton
        color="neutral"
        variant="outline"
        size="sm"
        icon="i-lucide-badge-x"
        :loading="busy === 'undo'"
        :disabled="busy !== null"
        :label="t('amendment.validationUndo.undo')"
        @click="startUndo"
      />
      <UButton
        ref="askButton"
        color="neutral"
        variant="outline"
        size="sm"
        icon="i-lucide-message-square-warning"
        :disabled="busy !== null"
        :label="t('amendment.validationUndo.correct')"
        @click="startCorrection"
      />
    </div>

    <UModal
      v-model:open="confirmOpen"
      :title="t('amendment.validationUndo.confirmTitle')"
      :description="
        [
          t('amendment.validationUndo.confirmDescription'),
          ...consequences,
        ].join(' ')
      "
    >
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            color="neutral"
            variant="outline"
            :label="t('amendment.actions.cancel')"
            :disabled="busy !== null"
            @click="confirmOpen = false"
          />
          <UButton
            icon="i-lucide-badge-x"
            :loading="busy === 'undo'"
            :label="t('amendment.validationUndo.undo')"
            @click="undo"
          />
        </div>
      </template>
    </UModal>
  </section>
</template>
