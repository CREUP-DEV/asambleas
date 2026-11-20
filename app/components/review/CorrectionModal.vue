<script setup lang="ts">
import { z } from "zod/v4";
import type { FormSubmitEvent } from "@nuxt/ui";
import { CORRECTION_NOTE_MAX_LENGTH } from "~~/shared/utils/schemas/document";

/**
 * "Pedir corrección": a required note for whoever presented a document or an
 * amendment. The parent sends it (POST .../correction) on `confirm` and
 * closes the modal when it succeeds. It keeps the last subject it named, so
 * its text does not read "«»" while it closes after the parent clears it.
 *
 * For an amendment the Secretaría may declare not admitted instead
 * (`inadmissible`, amendmentInadmissibleOnReview), it also asks «¿Puede
 * corregirla?» (AmendmentCorrectableChoice, user's decision of 2026-11-19):
 * «No» turns the note into the reason it is not admitted, and the dialog's
 * wording follows. `confirm` says which (`correctable`).
 */
const props = withDefaults(
  defineProps<{
    /** What is being sent back, e.g. the document title or "CEUM 4". */
    subject: string;
    kind: "document" | "amendment";
    busy?: boolean;
    /** Offer «¿Puede corregirla?»: the amendment may be declared not admitted. */
    inadmissible?: boolean;
    /** The amendment is public: a note it is not admitted with shows with it. */
    published?: boolean;
  }>(),
  { busy: false, inadmissible: false, published: false },
);

const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{ confirm: [note: string, correctable: boolean] }>();

const { t } = useI18n();

const formId = useId();

const shownSubject = ref(props.subject);
watch(
  () => props.subject,
  (value) => {
    if (value) shownSubject.value = value;
  },
);

const schema = computed(() =>
  z.object({
    note: z
      .string()
      .trim()
      .min(
        1,
        closing.value
          ? t("amendment.inadmissibleOnReview.noteRequired")
          : t("review.correction.noteRequired"),
      )
      .max(
        CORRECTION_NOTE_MAX_LENGTH,
        t("review.correction.noteTooLong", {
          max: CORRECTION_NOTE_MAX_LENGTH,
        }),
      ),
  }),
);

type CorrectionForm = z.output<typeof schema.value>;

const state = reactive<CorrectionForm>({ note: "" });
/** «¿Puede corregirla?»: yes unless the Secretaría says otherwise. */
const correctable = ref(true);
/** Declaring it not admitted: the wording follows. */
const closing = computed(() => props.inadmissible && !correctable.value);

watch(open, (isOpen) => {
  if (!isOpen) return;
  state.note = "";
  correctable.value = true;
});

function onSubmit(event: FormSubmitEvent<CorrectionForm>) {
  emit("confirm", event.data.note.trim(), !closing.value);
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('review.correction.title')"
    :description="
      t(
        props.kind === 'document'
          ? 'review.correction.descriptionDocument'
          : closing
            ? 'amendment.inadmissibleOnReview.description'
            : 'review.correction.descriptionAmendment',
        { subject: shownSubject },
      )
    "
    :dismissible="!props.busy"
  >
    <template #body>
      <UForm
        :id="formId"
        :schema="schema"
        :state="state"
        class="space-y-3"
        @submit="onSubmit"
      >
        <AmendmentCorrectableChoice
          v-if="props.inadmissible"
          v-model="correctable"
          :published="props.published"
          :disabled="props.busy"
        />
        <UFormField
          :label="
            closing
              ? t('amendment.inadmissibleOnReview.noteLabel')
              : t('review.correction.noteLabel')
          "
          :help="
            closing
              ? t('amendment.inadmissibleOnReview.noteHelp')
              : t('review.correction.noteHelp')
          "
          name="note"
          required
        >
          <UTextarea
            v-model="state.note"
            :rows="4"
            autoresize
            :maxrows="10"
            :maxlength="CORRECTION_NOTE_MAX_LENGTH"
            autofocus
            class="w-full"
          />
        </UFormField>
      </UForm>
    </template>
    <template #footer>
      <div class="flex w-full flex-wrap justify-end gap-2">
        <UButton
          color="neutral"
          variant="outline"
          :label="t('common.cancel')"
          :disabled="props.busy"
          @click="open = false"
        />
        <UButton
          type="submit"
          :form="formId"
          :color="closing ? 'error' : 'warning'"
          :icon="closing ? 'i-lucide-ban' : 'i-lucide-undo-2'"
          :label="
            closing
              ? t('amendment.inadmissibleOnReview.send')
              : t('review.correction.send')
          "
          :loading="props.busy"
        />
      </div>
    </template>
  </UModal>
</template>
