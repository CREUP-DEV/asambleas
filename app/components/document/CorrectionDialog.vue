<script setup lang="ts">
import type { CorrectionBody, DocumentDto } from "~~/shared/types/api";
import { CORRECTION_NOTE_MAX_LENGTH } from "~~/shared/utils/schemas/document";
import {
  documentPresenterMembers,
  formatMemberList,
} from "~/composables/document/documentPresenters";

/**
 * "Pedir corrección" (document:manage): a presented document goes back to
 * its presenters as a draft with a note saying what to fix
 * (POST .../correction with `CorrectionBody`). They fix it and send it
 * again. Emits `corrected` with the updated document (store it), and `stale`
 * after a conflict (refetch).
 *
 * The note survives a conflict: the dialog stays open with an explanation
 * so the Secretaría can send it again once the document reloads. It closes
 * by itself (with a toast) if the reloaded document is no longer waiting
 * for validation. The note is cleared only after it is sent.
 */
const props = defineProps<{
  document: DocumentDto;
  /** "/api/assemblies/{assembly}/documents/{document}" (slugs or ids). */
  documentApi: string;
}>();

const open = defineModel<boolean>("open", { default: false });

const emit = defineEmits<{
  corrected: [document: DocumentDto];
  stale: [];
}>();

const { t, locale } = useI18n();
const toast = useToast();
const { send, notifyError, isConflict } = useApi();

const note = ref("");
const touched = ref(false);
const sending = ref(false);
/** The last send hit a conflict: the document was reloaded meanwhile. */
const conflict = ref(false);
/** `updatedAt` the conflicting send used: wait until the reload replaces it. */
const staleAt = ref<string | null>(null);
const reloading = computed(
  () => conflict.value && props.document.updatedAt === staleAt.value,
);

watch(open, (isOpen) => {
  if (!isOpen) return;
  touched.value = false;
  conflict.value = false;
  staleAt.value = null;
});

// Someone validated, withdrew or corrected it meanwhile: nothing to ask.
watch(
  () => props.document.status,
  (status) => {
    if (!open.value || status === "submitted") return;
    open.value = false;
    note.value = "";
    toast.add({
      title: t("document.correction.noLongerSubmitted"),
      color: "info",
      icon: "i-lucide-info",
    });
  },
);

const trimmed = computed(() => note.value.trim());
const error = computed(() =>
  touched.value && trimmed.value.length === 0
    ? t("document.correction.noteRequired")
    : undefined,
);

/**
 * Every presenter gets the note back (main and co-presenters alike):
 * "El documento vuelve a CEUM y UPV con tu nota".
 */
const presenters = computed(() =>
  documentPresenterMembers(props.document).map((member) => member.acronym),
);
const presenterList = computed(() =>
  formatMemberList(presenters.value, locale.value),
);

async function confirm(): Promise<void> {
  touched.value = true;
  if (sending.value || reloading.value || trimmed.value.length === 0) return;
  sending.value = true;
  conflict.value = false;
  const updatedAt = props.document.updatedAt;
  try {
    const body: CorrectionBody = { note: trimmed.value, updatedAt };
    const updated = await send<DocumentDto>(`${props.documentApi}/correction`, {
      body,
    });
    open.value = false;
    note.value = "";
    emit("corrected", updated);
    toast.add({
      title: t("document.correction.success"),
      description:
        presenters.value.length > 0
          ? t(
              "document.correction.successMember",
              { member: presenterList.value },
              presenters.value.length,
            )
          : undefined,
      color: "success",
      icon: "i-lucide-check",
    });
  } catch (failure) {
    if (isConflict(failure)) {
      // Keep the dialog and the note; the inline alert explains it, and
      // sending waits for the reloaded document.
      conflict.value = true;
      staleAt.value = updatedAt;
      emit("stale");
    } else {
      notifyError(failure, "document.correction.error");
    }
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('document.correction.title')"
    :description="
      presenters.length > 0
        ? t(
            'document.correction.descriptionMember',
            { member: presenterList },
            presenters.length,
          )
        : t('document.correction.description')
    "
    :dismissible="!sending"
    :ui="{ footer: 'justify-end gap-2' }"
  >
    <template #body>
      <UAlert
        v-if="conflict"
        class="mb-4"
        color="warning"
        variant="subtle"
        icon="i-lucide-refresh-ccw"
        :title="t('document.correction.conflict')"
        role="alert"
      />
      <UFormField
        :label="t('document.correction.note')"
        :help="t('document.correction.noteHelp')"
        :error="error"
        required
      >
        <UTextarea
          v-model="note"
          :rows="4"
          autoresize
          :maxrows="12"
          :maxlength="CORRECTION_NOTE_MAX_LENGTH"
          autofocus
          class="w-full"
          @blur="touched = true"
        />
      </UFormField>
    </template>

    <template #footer="{ close }">
      <UButton
        color="neutral"
        variant="ghost"
        :label="t('common.cancel')"
        :disabled="sending"
        @click="close"
      />
      <UButton
        color="warning"
        icon="i-lucide-undo-2"
        :label="t('document.correction.confirm')"
        :loading="sending || reloading"
        :disabled="sending || reloading"
        @click="confirm"
      />
    </template>
  </UModal>
</template>
