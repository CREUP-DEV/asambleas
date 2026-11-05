<script setup lang="ts">
import type {
  AmendmentDto,
  CorrectionBody,
  DocumentAmendmentsDto,
  PublishAmendmentsBody,
  ValidateAmendmentsBody,
} from "~~/shared/types/api";
import {
  amendmentReviewSentenceKey,
  amendmentReviewView,
  isAmendmentPresenter,
} from "~/composables/amendment/workspace";

/**
 * Where an amendment stands with the Secretaría, as a sentence that says
 * what happens next, and the actions that move it on:
 * - its authors, when a correction was asked: the note and "Corregir y
 *   volver a enviar" (opens the composer on the draft);
 * - the Secretaría, while it is waiting (can.validate): validate and
 *   publish, validate without publishing, or ask for a correction with a
 *   note (POST .../validate, POST .../[amendment]/correction);
 * - the Secretaría, once validated (can.publish), also after the amendment
 *   was decided: publish it (POST .../publish).
 * Validation and publication answer with the whole list (`replaced`); a
 * correction answers with the amendment, now a draft again (`corrected`).
 * A published amendment needs no note, except for its authors (so they know
 * everyone sees it now) or while the Mesa still has to admit it.
 *
 * Focus: after an action the status sentence takes it (it is also announced),
 * or, when the panel is gone (published, nothing left to say), `settled`
 * lets the detail move it. Cancelling the correction form gives it back to
 * "Pedir corrección".
 */
const props = defineProps<{
  amendment: AmendmentDto;
  /** Base URL of the document's amendments: .../amendments. */
  amendmentsUrl: string;
}>();

const emit = defineEmits<{
  /** Open the composer on this draft. */
  edit: [amendment: AmendmentDto];
  /** The whole list after a validation or a publication. */
  replaced: [dto: DocumentAmendmentsDto];
  /** The amendment went back to its authors as a draft. */
  corrected: [amendment: AmendmentDto];
  /** Something moved meanwhile (409): refetch. */
  changed: [];
  /** An action left nothing to show here: the parent should take focus. */
  settled: [];
}>();

const { t } = useI18n();
const api = useApi();
const toast = useToast();
const { member } = useMe();

type Busy = "validate_publish" | "validate" | "publish" | "correction";
const busy = ref<Busy | null>(null);
const asking = ref(false);
const note = ref("");
const noteAttempted = ref(false);
const noteInput = useTemplateRef<{ textareaRef?: HTMLTextAreaElement }>(
  "noteInput",
);
const statusEl = useTemplateRef<HTMLElement>("statusEl");
const askButton = useTemplateRef<{ $el?: HTMLElement }>("askButton");

watch(
  () => props.amendment.id,
  () => {
    asking.value = false;
    note.value = "";
    noteAttempted.value = false;
  },
);

const presenter = computed(() =>
  isAmendmentPresenter(props.amendment, member.value?.id ?? null),
);
const view = computed(() => {
  const current = amendmentReviewView(props.amendment);
  if (
    current?.key === "published" &&
    !current.awaitingAdmission &&
    !presenter.value
  ) {
    return null;
  }
  return current;
});
const sentence = computed(() =>
  view.value
    ? t(amendmentReviewSentenceKey(view.value.key, presenter.value))
    : "",
);
const ICON_CLASSES = {
  neutral: "text-muted",
  info: "text-info",
  warning: "text-warning",
  success: "text-success",
  primary: "text-primary",
} as const;
const canValidate = computed(() => props.amendment.can.validate);
const canPublish = computed(() => props.amendment.can.publish);
const noteMissing = computed(() => !note.value.trim());

function fail(error: unknown, key: string): void {
  api.notifyError(error, key);
  if (api.isConflict(error) || api.errorStatus(error) === 404) {
    emit("changed");
  }
}

/** The clicked button is gone after an action: put focus on what changed. */
async function focusStatus(): Promise<void> {
  await nextTick();
  if (statusEl.value) statusEl.value.focus();
  else emit("settled");
}

async function validate(publish: boolean): Promise<void> {
  busy.value = publish ? "validate_publish" : "validate";
  try {
    const body: ValidateAmendmentsBody = {
      amendmentIds: [props.amendment.id],
      publish,
    };
    const dto = await api.send<DocumentAmendmentsDto>(
      `${props.amendmentsUrl}/validate`,
      { body },
    );
    toast.add({
      title: publish
        ? t("amendment.review.toasts.validatedPublished")
        : t("amendment.review.toasts.validated"),
      description: publish
        ? undefined
        : t("amendment.review.toasts.validatedDescription"),
      color: "success",
      icon: publish ? "i-lucide-eye" : "i-lucide-badge-check",
    });
    emit("replaced", dto);
    void focusStatus();
  } catch (error) {
    fail(error, "amendment.review.toasts.validateFailed");
  } finally {
    busy.value = null;
  }
}

async function publish(): Promise<void> {
  busy.value = "publish";
  try {
    const body: PublishAmendmentsBody = { amendmentIds: [props.amendment.id] };
    const dto = await api.send<DocumentAmendmentsDto>(
      `${props.amendmentsUrl}/publish`,
      { body },
    );
    toast.add({
      title: t("amendment.review.toasts.published"),
      color: "success",
      icon: "i-lucide-eye",
    });
    emit("replaced", dto);
    void focusStatus();
  } catch (error) {
    fail(error, "amendment.review.toasts.publishFailed");
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

async function askCorrection(): Promise<void> {
  noteAttempted.value = true;
  if (noteMissing.value) {
    noteInput.value?.textareaRef?.focus();
    return;
  }
  busy.value = "correction";
  try {
    const body: CorrectionBody = {
      note: note.value.trim(),
      updatedAt: props.amendment.updatedAt,
    };
    const updated = await api.send<AmendmentDto>(
      `${props.amendmentsUrl}/${props.amendment.id}/correction`,
      { body },
    );
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
    fail(error, "amendment.review.toasts.correctionFailed");
  } finally {
    busy.value = null;
  }
}
</script>

<template>
  <section
    v-if="view"
    class="flex flex-col gap-3 rounded-lg border p-3 sm:p-4"
    :class="
      view.private
        ? 'border-default bg-elevated/40 border-dashed'
        : 'border-default'
    "
    :aria-label="t('amendment.review.label')"
  >
    <div
      ref="statusEl"
      class="flex items-start gap-2.5 rounded-md outline-none"
      tabindex="-1"
      aria-live="polite"
    >
      <UIcon
        :name="view.icon"
        class="mt-0.5 size-5 shrink-0"
        :class="ICON_CLASSES[view.color]"
        aria-hidden="true"
      />
      <div class="min-w-0 flex-1 space-y-1">
        <p class="text-highlighted text-sm font-semibold">
          {{ t(`amendment.review.badges.${view.key}`) }}
        </p>
        <p class="text-default text-sm">
          {{ sentence }}
        </p>
        <p v-if="view.awaitingAdmission" class="text-default text-sm">
          {{ t("amendment.review.awaitingAdmission") }}
        </p>
        <p
          v-if="canValidate && amendment.late"
          class="text-warning flex items-center gap-1 text-sm"
        >
          <UIcon
            name="i-lucide-clock-alert"
            class="size-4 shrink-0"
            aria-hidden="true"
          />
          {{ t("amendment.review.lateHint") }}
        </p>
      </div>
    </div>

    <!-- The note the Secretaría left for the authors. -->
    <blockquote
      v-if="
        amendment.correctionNote &&
        (view.key === 'correction' || view.key === 'correction_sent')
      "
      class="border-warning bg-default rounded-e-md border-s-4 px-3 py-2"
    >
      <p class="text-muted text-xs font-medium">
        {{ t("amendment.review.noteFromSecretaria") }}
      </p>
      <p class="text-default text-sm whitespace-pre-line">
        {{ amendment.correctionNote }}
      </p>
    </blockquote>

    <!-- Authors: fix the draft and send it again. -->
    <div
      v-if="view.key === 'correction' && amendment.can.edit"
      class="flex flex-wrap gap-2"
    >
      <UButton
        icon="i-lucide-pencil"
        :label="t('amendment.review.actions.fix')"
        @click="emit('edit', amendment)"
      />
    </div>

    <!-- Secretaría: validate, or ask for a correction. -->
    <template v-if="canValidate">
      <form
        v-if="asking"
        class="flex flex-col gap-2"
        novalidate
        @submit.prevent="askCorrection"
      >
        <UFormField
          :label="t('amendment.review.correctionNote')"
          :help="t('amendment.review.correctionHelp')"
          :error="
            noteAttempted && noteMissing
              ? t('amendment.review.correctionRequired')
              : undefined
          "
          required
        >
          <UTextarea
            ref="noteInput"
            v-model="note"
            :rows="3"
            autoresize
            :maxrows="10"
            :maxlength="5000"
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

      <div v-else class="flex flex-col gap-2">
        <div class="flex flex-wrap items-center gap-2">
          <UButton
            icon="i-lucide-badge-check"
            :loading="busy === 'validate_publish'"
            :disabled="busy !== null"
            :label="t('amendment.review.actions.validatePublish')"
            @click="validate(true)"
          />
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-eye-off"
            :loading="busy === 'validate'"
            :disabled="busy !== null"
            :label="t('amendment.review.actions.validateOnly')"
            @click="validate(false)"
          />
          <UButton
            ref="askButton"
            color="warning"
            variant="ghost"
            icon="i-lucide-message-square-warning"
            :disabled="busy !== null"
            :label="t('amendment.review.actions.askCorrection')"
            @click="startCorrection"
          />
        </div>
        <p class="text-muted text-xs">
          {{ t("amendment.review.validateOnlyHint") }}
        </p>
      </div>
    </template>

    <!-- Secretaría: make a validated amendment public. -->
    <div v-else-if="canPublish" class="flex flex-wrap items-center gap-2">
      <UButton
        icon="i-lucide-eye"
        :loading="busy === 'publish'"
        :disabled="busy !== null"
        :label="t('amendment.review.actions.publish')"
        @click="publish"
      />
    </div>
  </section>
</template>
