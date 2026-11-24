<script setup lang="ts">
import { createId } from "@paralleldrive/cuid2";
import type {
  DocumentDto,
  FormCorrectionDto,
  FormCorrectionsDto,
} from "~~/shared/types/api";
import type { Block } from "~~/shared/types/content";
import type { ContentPages } from "~/components/content/ContentView.vue";
import { diffPassage } from "~~/shared/utils/content/diff";
import { FORM_CORRECTION_REASON_MAX_LENGTH } from "~~/shared/utils/schemas/document";
import { formatDateTime } from "~/utils/format";
import { usePendingConciliation } from "~/composables/document/pendingConciliation";

/**
 * Corrections of form to the approved text (user's decisions of
 * 2026-11-21), on the consolidated text page. The Secretaría and the Mesa
 * edit the text in force freely and it replaces the consolidated version at
 * once, with a reason and no annex; a presenter proposes one, which the
 * Secretaría applies or rejects here. Below, every correction with its
 * reason, who made it and its changes (diffPassage over the text it was
 * made on, as an amendment's); the ones not applied only reach those who
 * may make or decide them.
 *
 * `editing` lets the page hide the text while the editor shows it; the
 * page opens the editor (`start`) from the button next to the text's
 * heading, or on arriving with `?corregir` (the document's «Más» menu).
 */
const props = defineProps<{
  document: DocumentDto;
  /** "/api/assemblies/{assembly}/documents/{document}" (ids). */
  documentApi: string;
  /**
   * An amendment's code as the reader reads it: a conciliation of a passage
   * the final vote left pending (user's decisions of 2026-11-21) is listed
   * here too, as «Conciliación de E3 y E5».
   */
  labelOf?: (amendmentId: string) => string;
  /** The approved text's PDF pages, beside the editor as in the reader. */
  pages?: ContentPages | null;
}>();

const emit = defineEmits<{ changed: [] }>();

const editing = defineModel<boolean>("editing", { default: false });

const { t, locale } = useI18n();
const toast = useToast();
const { get, send, notifyError, isConflict } = useApi();

const url = computed(() => `${props.documentApi}/form-corrections`);
const mode = computed(() => props.document.can.correctForm);
const current = computed(() => props.document.consolidatedVersion);

const data = ref<FormCorrectionsDto | null>(null);
const busy = ref(false);

async function load(): Promise<void> {
  try {
    data.value = await get<FormCorrectionsDto>(url.value);
  } catch (error) {
    notifyError(error, "workspace.formCorrections.errors.load");
  }
}
onMounted(load);
// Another correction applied (here or elsewhere) changes the text in force.
watch(
  () => current.value?.id,
  (id, previous) => {
    if (id !== previous) void load();
  },
);

/** Newest first. */
const corrections = computed(() =>
  [...(data.value?.corrections ?? [])].reverse(),
);
const pending = computed(() =>
  corrections.value.filter((correction) => correction.status === "pending"),
);

// Editing -------------------------------------------------------------------

const draft = ref<Block[]>([]);
const reason = ref("");
const reasonTouched = ref(false);
const editorKey = ref(0);
/** The version the editor opened: what the correction is made on. */
const fromVersionId = ref<string | null>(null);

function start(): void {
  if (!current.value) return;
  draft.value = structuredClone(toRaw(current.value.blocks));
  fromVersionId.value = current.value.id;
  reason.value = "";
  reasonTouched.value = false;
  editorKey.value += 1;
  editing.value = true;
}
function cancel(): void {
  editing.value = false;
}

defineExpose({ start, load });

const { codes: joinedCodes } = usePendingConciliation();
/** «E3 y E5»: the amendments a conciliation words. */
function passageCodes(correction: FormCorrectionDto): string {
  return joinedCodes(
    correction.passage?.amendmentIds ?? [],
    props.labelOf ?? (() => "?"),
  );
}

const changedText = computed(
  () =>
    current.value !== null &&
    JSON.stringify(draft.value) !== JSON.stringify(current.value?.blocks),
);
const reasonMissing = computed(() => reason.value.trim().length === 0);

async function submit(): Promise<void> {
  reasonTouched.value = true;
  if (!fromVersionId.value || reasonMissing.value || !changedText.value) {
    return;
  }
  busy.value = true;
  try {
    data.value = await send<FormCorrectionsDto>(url.value, {
      body: {
        fromVersionId: fromVersionId.value,
        blocks: draft.value,
        reason: reason.value.trim(),
      },
    });
    editing.value = false;
    toast.add({
      id: "form-correction-saved",
      title:
        mode.value === "direct"
          ? t("workspace.formCorrections.toasts.applied")
          : t("workspace.formCorrections.toasts.proposed"),
      color: "success",
      icon: "i-lucide-spell-check",
    });
    emit("changed");
  } catch (error) {
    notifyError(error, "workspace.formCorrections.errors.save");
    // The text in force changed meanwhile: the page reloads it, and the
    // editor keeps what was typed so nothing is lost.
    if (isConflict(error)) emit("changed");
  } finally {
    busy.value = false;
  }
}

// Decisions -----------------------------------------------------------------

const rejecting = ref<string | null>(null);
const rejectNote = ref("");

async function decide(
  correction: FormCorrectionDto,
  decision: "apply" | "reject",
): Promise<void> {
  busy.value = true;
  try {
    data.value = await send<FormCorrectionsDto>(
      `${url.value}/${encodeURIComponent(correction.id)}/decision`,
      {
        body: {
          decision,
          note: decision === "reject" ? rejectNote.value.trim() || null : null,
          updatedAt: correction.updatedAt,
        },
      },
    );
    rejecting.value = null;
    rejectNote.value = "";
    toast.add({
      id: `form-correction-${correction.id}`,
      title:
        decision !== "apply"
          ? t("workspace.formCorrections.toasts.rejected")
          : correction.passage
            ? t("document.pendingConciliation.toasts.applied")
            : t("workspace.formCorrections.toasts.applied"),
      color: decision === "apply" ? "success" : "neutral",
      icon: decision === "apply" ? "i-lucide-spell-check" : "i-lucide-x",
    });
    if (decision === "apply") emit("changed");
  } catch (error) {
    notifyError(error, "workspace.formCorrections.errors.decide");
    if (isConflict(error)) {
      void load();
      emit("changed");
    }
  } finally {
    busy.value = false;
  }
}

async function withdraw(correction: FormCorrectionDto): Promise<void> {
  busy.value = true;
  try {
    data.value = await send<FormCorrectionsDto>(
      `${url.value}/${encodeURIComponent(correction.id)}`,
      { method: "DELETE", body: { updatedAt: correction.updatedAt } },
    );
  } catch (error) {
    notifyError(error, "workspace.formCorrections.errors.decide");
    if (isConflict(error)) void load();
  } finally {
    busy.value = false;
  }
}

// Changes -------------------------------------------------------------------

const expanded = ref<Set<string>>(new Set());
function toggle(id: string): void {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}
/** Its changes as an amendment's over the text it was made on. */
function opsOf(correction: FormCorrectionDto) {
  return diffPassage(correction.before, correction.blocks, null, createId);
}

const STATUS_COLORS = {
  pending: "warning",
  applied: "success",
  rejected: "error",
  withdrawn: "neutral",
  void: "neutral",
} as const;

function when(value: string | null): string {
  return value ? formatDateTime(value, { locale: locale.value }) : "";
}
</script>

<template>
  <section
    v-if="mode || corrections.length > 0"
    class="flex flex-col gap-4"
    aria-labelledby="form-corrections"
  >
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <h2
          id="form-corrections"
          class="text-highlighted text-lg font-semibold"
        >
          {{ t("workspace.formCorrections.title") }}
        </h2>
        <p class="text-muted text-sm">
          {{
            mode === "propose"
              ? t("workspace.formCorrections.descriptionPropose")
              : t("workspace.formCorrections.description")
          }}
        </p>
      </div>
    </div>

    <UAlert
      v-if="pending.length > 0 && document.can.manage && !editing"
      color="warning"
      variant="subtle"
      icon="i-lucide-inbox"
      :title="
        t(
          'workspace.formCorrections.pendingTitle',
          { count: pending.length },
          pending.length,
        )
      "
    />

    <!-- The editor over the text in force. -->
    <form
      v-if="editing"
      class="border-default flex flex-col gap-4 rounded-lg border p-4 sm:p-6"
      @submit.prevent="submit"
    >
      <UAlert
        color="info"
        variant="subtle"
        icon="i-lucide-info"
        :title="
          mode === 'direct'
            ? t('workspace.formCorrections.editHintDirect')
            : t('workspace.formCorrections.editHintPropose')
        "
      />
      <ClientOnly>
        <ContentBlockEditor
          :key="editorKey"
          v-model="draft"
          amend
          table-look
          outline
          :pages="pages"
          :label="t('workspace.formCorrections.textLabel')"
        />
        <template #fallback>
          <USkeleton aria-hidden="true" class="h-96 w-full" />
        </template>
      </ClientOnly>
      <UFormField
        :label="t('workspace.formCorrections.reason')"
        :help="t('workspace.formCorrections.reasonHelp')"
        :error="
          reasonTouched && reasonMissing
            ? t('workspace.formCorrections.reasonRequired')
            : false
        "
        required
      >
        <UTextarea
          v-model="reason"
          :rows="2"
          autoresize
          :maxlength="FORM_CORRECTION_REASON_MAX_LENGTH"
          class="w-full"
          @blur="reasonTouched = true"
        />
      </UFormField>
      <p v-if="!changedText" class="text-muted text-sm">
        {{ t("workspace.formCorrections.noChange") }}
      </p>
      <div class="flex flex-wrap justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :label="t('common.cancel')"
          :disabled="busy"
          @click="cancel"
        />
        <UButton
          type="submit"
          icon="i-lucide-check"
          :label="
            mode === 'direct'
              ? t('workspace.formCorrections.apply')
              : t('workspace.formCorrections.send')
          "
          :loading="busy"
          :disabled="!changedText || reasonMissing"
        />
      </div>
    </form>

    <!-- Every correction, newest first. -->
    <ol v-if="corrections.length > 0" class="flex flex-col gap-2">
      <li
        v-for="correction in corrections"
        :key="correction.id"
        class="border-default flex flex-col gap-2 rounded-lg border p-3"
      >
        <div class="flex flex-wrap items-center gap-2 text-sm">
          <UBadge
            :color="STATUS_COLORS[correction.status]"
            variant="subtle"
            size="sm"
            :label="t(`workspace.formCorrections.status.${correction.status}`)"
          />
          <span class="text-highlighted font-medium">
            {{ t(`workspace.formCorrections.madeAs.${correction.madeAs}`) }}
          </span>
          <span class="text-muted">
            {{ when(correction.decidedAt ?? correction.createdAt) }}
          </span>
        </div>
        <p
          v-if="correction.passage"
          class="text-highlighted flex items-center gap-1.5 text-sm font-medium"
        >
          <UIcon name="i-lucide-git-merge" class="size-4 shrink-0" />
          {{
            t("document.pendingConciliation.entry", {
              codes: passageCodes(correction),
            })
          }}
        </p>
        <p
          v-if="correction.reason"
          class="text-default text-sm whitespace-pre-line"
        >
          {{ correction.reason }}
        </p>
        <p
          v-if="correction.decisionNote"
          class="text-muted text-sm whitespace-pre-line"
        >
          {{
            t("workspace.formCorrections.decisionNote", {
              note: correction.decisionNote,
            })
          }}
        </p>
        <p
          v-if="correction.status === 'pending' && !correction.onCurrentText"
          class="text-warning text-sm"
        >
          {{ t("workspace.formCorrections.overtaken") }}
        </p>

        <div class="flex flex-wrap items-center gap-2">
          <UButton
            color="neutral"
            variant="link"
            size="xs"
            class="px-0"
            :icon="
              expanded.has(correction.id)
                ? 'i-lucide-chevron-up'
                : 'i-lucide-chevron-down'
            "
            :aria-expanded="expanded.has(correction.id)"
            :aria-controls="`form-correction-diff-${correction.id}`"
            :label="
              expanded.has(correction.id)
                ? t('workspace.consolidatedView.hideChanges')
                : t('workspace.consolidatedView.showChanges')
            "
            @click="toggle(correction.id)"
          />
          <template v-if="correction.status === 'pending'">
            <UButton
              v-if="correction.can.apply"
              size="xs"
              icon="i-lucide-check"
              :label="t('workspace.formCorrections.applyProposal')"
              :loading="busy"
              @click="decide(correction, 'apply')"
            />
            <UButton
              v-if="correction.can.reject && rejecting !== correction.id"
              size="xs"
              color="error"
              variant="outline"
              icon="i-lucide-x"
              :label="t('workspace.formCorrections.reject')"
              :disabled="busy"
              @click="
                rejecting = correction.id;
                rejectNote = '';
              "
            />
            <UButton
              v-if="correction.can.withdraw"
              size="xs"
              color="neutral"
              variant="outline"
              icon="i-lucide-undo-2"
              :label="t('workspace.formCorrections.withdraw')"
              :loading="busy"
              @click="withdraw(correction)"
            />
          </template>
        </div>

        <div
          v-if="rejecting === correction.id"
          class="flex flex-col gap-2 border-t pt-2"
        >
          <UFormField :label="t('workspace.formCorrections.rejectNote')">
            <UTextarea
              v-model="rejectNote"
              :rows="2"
              autoresize
              :maxlength="FORM_CORRECTION_REASON_MAX_LENGTH"
              class="w-full"
            />
          </UFormField>
          <div class="flex justify-end gap-2">
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              :label="t('common.cancel')"
              @click="rejecting = null"
            />
            <UButton
              size="xs"
              color="error"
              icon="i-lucide-x"
              :label="t('workspace.formCorrections.rejectConfirm')"
              :loading="busy"
              @click="decide(correction, 'reject')"
            />
          </div>
        </div>

        <div
          v-if="expanded.has(correction.id)"
          :id="`form-correction-diff-${correction.id}`"
          class="border-default border-t pt-3"
        >
          <ContentAmendmentDiff
            v-if="opsOf(correction).length > 0"
            :id="correction.id"
            :base="correction.before"
            :ops="opsOf(correction)"
            :context="1"
          />
          <!-- Only how tables look changed: the diff has no words for it. -->
          <p v-else class="text-muted text-sm">
            {{ t("workspace.formCorrections.tableLookOnly") }}
          </p>
        </div>
      </li>
    </ol>
  </section>
</template>
