<script setup lang="ts">
import { z } from "zod/v4";
import type { FormSubmitEvent } from "@nuxt/ui";
import { CORRECTION_NOTE_MAX_LENGTH } from "~~/shared/utils/schemas/document";

/**
 * "Pedir corrección": a required note for whoever presented a document or an
 * amendment. The parent sends it (POST .../correction) on `confirm` and
 * closes the modal when it succeeds. It keeps the last subject it named, so
 * its text does not read "«»" while it closes after the parent clears it.
 */
const props = withDefaults(
  defineProps<{
    /** What is being sent back, e.g. the document title or "CEUM 4". */
    subject: string;
    kind: "document" | "amendment";
    busy?: boolean;
  }>(),
  { busy: false },
);

const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{ confirm: [note: string] }>();

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
      .min(1, t("review.correction.noteRequired"))
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

watch(open, (isOpen) => {
  if (isOpen) state.note = "";
});

function onSubmit(event: FormSubmitEvent<CorrectionForm>) {
  emit("confirm", event.data.note.trim());
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
        class="space-y-2"
        @submit="onSubmit"
      >
        <UFormField
          :label="t('review.correction.noteLabel')"
          :help="t('review.correction.noteHelp')"
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
          color="warning"
          icon="i-lucide-undo-2"
          :label="t('review.correction.send')"
          :loading="props.busy"
        />
      </div>
    </template>
  </UModal>
</template>
