<script setup lang="ts">
import {
  DEFAULT_ASSEMBLY_SETTINGS,
  type AmendmentStatus,
} from "~~/shared/constants/domain";
import type {
  AdmissionBody,
  AmendmentAdmissionDto,
  AmendmentDto,
  CorrectionBody,
  DocumentAmendmentsDto,
  PublishAmendmentsBody,
  ValidateAmendmentsBody,
} from "~~/shared/types/api";
import { transactionalProgressOf } from "~/composables/amendment/transactional";
import { useTransactionalProgressText } from "~/composables/amendment/useTransactionalProgressText";
import {
  amendmentDisplayLabel,
  amendmentReviewSentenceKey,
  amendmentReviewView,
  isAmendmentPresenter,
} from "~/composables/amendment/workspace";
import {
  canRecordAdmission,
  type AdmissionChoice,
} from "~/components/review/-queue";

/**
 * Where an amendment stands with the Secretaría, as a sentence that says
 * what happens next, and the actions that move it on:
 * - its authors, when a correction was asked: the note and "Corregir y
 *   volver a enviar" (opens the composer on the draft);
 * - the Secretaría, while it is waiting (can.validate): validate and
 *   publish, validate without publishing, or ask for a correction with a
 *   note (POST .../validate, POST .../[amendment]/correction). A
 *   transactional is always published when validated (it replaces
 *   amendments everyone can read), so it offers no private validation and
 *   says why;
 * - the Secretaría, once validated (can.publish), also after the amendment
 *   was decided: publish it (POST .../publish);
 * - the Secretaría or the Mesa, on a late one validated and waiting for the
 *   assembly: "Anotar la decisión de la asamblea", the same dialog as the
 *   inbox (POST .../amendments/admission). It sits next to "Publicar" while
 *   the amendment is private, and is the main action once it is public.
 * Validation and publication answer with the whole list (`replaced`); a
 * correction answers with the amendment, now a draft again (`corrected`).
 * A published amendment needs no note, except for its authors (so they know
 * everyone sees it now) or while the assembly still has to decide whether
 * to treat it (a late one).
 *
 * A presented transactional says what it waits for, to everyone who sees
 * it: the main authors of the amendments it would replace (naming who is
 * missing), or that one rejected it (closed, the originals carry on), or
 * which amendments it replaced. While the Secretaría has it, the usual
 * review sentence stays, plus what checking it will do (replace them).
 *
 * Focus: after an action the status sentence takes it (it is also announced),
 * or, when the panel is gone (published, nothing left to say), `settled`
 * lets the detail move it. Cancelling the correction form gives it back to
 * "Pedir corrección".
 */
const props = withDefaults(
  defineProps<{
    amendment: AmendmentDto;
    /** Base URL of the document's amendments: .../amendments. */
    amendmentsUrl: string;
    /** Names the amendments a transactional combines. */
    labelOf?: (id: string) => string;
    /** Status of another amendment, to tell whether a transactional replaced them. */
    statusOf?: (id: string) => AmendmentStatus | undefined;
  }>(),
  { labelOf: undefined, statusOf: undefined },
);

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
const { assembly } = useCurrentAssembly();

type Busy =
  "validate_publish" | "validate" | "publish" | "correction" | "admission";
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
    admissionOpen.value = false;
    admissionSaved.value = false;
  },
);

const presenter = computed(() =>
  isAmendmentPresenter(props.amendment, member.value?.id ?? null),
);
const progressText = useTransactionalProgressText();
const progress = computed(() =>
  transactionalProgressOf(
    props.amendment,
    member.value?.id ?? null,
    props.statusOf,
  ),
);
/** The transactional's own sentence, outside the Secretaría's stages. */
const progressSentence = computed(() =>
  progress.value ? progressText.sentence(progress.value, props.labelOf) : null,
);
const afterSecretaria = computed(() =>
  progress.value
    ? progressText.afterSecretaria(
        progress.value,
        props.labelOf,
        props.statusOf,
      )
    : null,
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
/** Late, public, waiting for the assembly: that is the news, not "Publicada". */
const latePublic = computed(
  () => view.value?.key === "published" && view.value.awaitingAdmission,
);
/** What the status block says: title, sentence, icon and colour. */
const status = computed(() => {
  if (progress.value && progressSentence.value) {
    return {
      icon: progress.value.icon,
      color: progress.value.color,
      title: progressText.summary(progress.value, props.labelOf),
      sentence: progressSentence.value,
      private: view.value?.private ?? false,
    };
  }
  if (!view.value) return null;
  if (latePublic.value) {
    return {
      icon: "i-lucide-clock-alert",
      color: "warning" as const,
      title: t("amendment.late"),
      sentence: t("amendment.lateState.awaitingSentence"),
      private: false,
    };
  }
  return {
    icon: view.value.icon,
    color: view.value.color,
    title: t(`amendment.review.badges.${view.value.key}`),
    sentence: t(amendmentReviewSentenceKey(view.value.key, presenter.value)),
    private: view.value.private,
  };
});
/** The late line under a private review state (validated, not public yet). */
const lateLine = computed(
  () => Boolean(view.value?.awaitingAdmission) && !latePublic.value,
);
const ICON_CLASSES = {
  neutral: "text-muted",
  info: "text-info",
  warning: "text-warning",
  success: "text-success",
  primary: "text-primary",
  error: "text-error",
} as const;
const canValidate = computed(() => props.amendment.can.validate);
/** Validating a transactional always publishes it. */
const publishesOnValidation = computed(
  () => props.amendment.kind === "transactional",
);
const canPublish = computed(() => props.amendment.can.publish);
const noteMissing = computed(() => !note.value.trim());

/** Late, validated and waiting for the assembly; the actor may record it. */
const canAdmit = computed(() => canRecordAdmission(props.amendment));
const admissionOpen = ref(false);
/** Saved: focus moves once the refetched amendment no longer waits. */
const admissionSaved = ref(false);
const label = computed(
  () => amendmentDisplayLabel(props.amendment) ?? t("review.amendments.noCode"),
);
const settings = computed(() => ({
  ...DEFAULT_ASSEMBLY_SETTINGS,
  ...assembly.value?.settings,
}));

watch(canAdmit, (value) => {
  if (value || !admissionSaved.value) return;
  admissionSaved.value = false;
  void focusStatus();
});

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

async function validate(requested: boolean): Promise<void> {
  const publish = requested || publishesOnValidation.value;
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

async function recordAdmission(choice: AdmissionChoice): Promise<void> {
  busy.value = "admission";
  try {
    const body: AdmissionBody = {
      amendmentIds: [props.amendment.id],
      ...choice,
    };
    const result = await api.send<AmendmentAdmissionDto>(
      `${props.amendmentsUrl}/admission`,
      { body },
    );
    admissionOpen.value = false;
    // A failed vote leaves it out even if the dialog opened to treat it.
    const key = result.admission === "admitted" ? "treat" : "notTreat";
    toast.add({
      title: t(`review.late.done.${key}.one`, { label: label.value }),
      description: t(`review.late.done.${key}Hint`, 1),
      color: "success",
      icon: "i-lucide-check",
    });
    admissionSaved.value = true;
    emit("changed");
  } catch (error) {
    if (api.isConflict(error)) admissionOpen.value = false;
    fail(error, "review.late.decisionError");
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
    v-if="status"
    class="flex flex-col gap-3 rounded-lg border p-3 sm:p-4"
    :class="
      status.private
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
        :name="status.icon"
        class="mt-0.5 size-5 shrink-0"
        :class="ICON_CLASSES[status.color]"
        aria-hidden="true"
      />
      <div class="min-w-0 flex-1 space-y-1">
        <p class="text-highlighted text-sm font-semibold">
          {{ status.title }}
        </p>
        <p class="text-default text-sm">
          {{ status.sentence }}
        </p>
        <p v-if="afterSecretaria" class="text-default text-sm">
          {{ afterSecretaria }}
        </p>
        <p v-if="lateLine" class="text-default text-sm">
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
        (view?.key === 'correction' || view?.key === 'correction_sent')
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
      v-if="view?.key === 'correction' && amendment.can.edit"
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
            v-if="!publishesOnValidation"
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
          {{
            publishesOnValidation
              ? t("amendment.review.transactionalPublishHint")
              : t("amendment.review.validateOnlyHint")
          }}
        </p>
      </div>
    </template>

    <!--
      Secretaría: make a validated amendment public. Secretaría or Mesa:
      record the assembly's decision on a late one.
    -->
    <div
      v-else-if="canPublish || canAdmit"
      class="flex flex-wrap items-center gap-2"
    >
      <UButton
        v-if="canPublish"
        icon="i-lucide-eye"
        :loading="busy === 'publish'"
        :disabled="busy !== null"
        :label="t('amendment.review.actions.publish')"
        @click="publish"
      />
      <UButton
        v-if="canAdmit"
        :color="canPublish ? 'neutral' : 'primary'"
        :variant="canPublish ? 'outline' : 'solid'"
        icon="i-lucide-scale"
        :loading="busy === 'admission'"
        :disabled="busy !== null"
        :label="t('review.late.dialog.title')"
        @click="admissionOpen = true"
      />
    </div>

    <ReviewAdmissionModal
      v-if="canAdmit"
      v-model:open="admissionOpen"
      :subject="label"
      :count="1"
      document-title=""
      :all-public="amendment.publishedAt !== null"
      :settings="settings"
      :assembly-id="assembly?.id ?? null"
      :busy="busy === 'admission'"
      @confirm="recordAdmission"
    />
  </section>
</template>
