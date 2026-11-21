<script setup lang="ts">
import type { RecordLine } from "~~/shared/utils/agreementsRecord";

/**
 * One line of the acta de acuerdos in the Secretaría's panel: what the
 * record prints, and its correction. The words replace the proposal while
 * the suffix («, por asentimiento») still follows the vote; the line may
 * also be left out. Saving emits the correction; null words and not
 * omitted take it back.
 */
const props = defineProps<{
  line: RecordLine;
  /** «3.» or «a)»; null when it is left out. */
  label: string | null;
  saving: boolean;
  /** The record no longer follows the votes: nothing to correct here. */
  readonly: boolean;
}>();

const emit = defineEmits<{
  save: [correction: { text: string | null; omitted: boolean }];
}>();

const { t } = useI18n();

const editing = ref(false);
const draft = ref("");

function startEditing(): void {
  draft.value = props.line.corrected ?? props.line.proposed;
  editing.value = true;
}

function save(): void {
  const words = draft.value.trim();
  emit("save", {
    text: words && words !== props.line.proposed ? words : null,
    omitted: props.line.omitted,
  });
  editing.value = false;
}

function reset(): void {
  emit("save", { text: null, omitted: props.line.omitted });
  editing.value = false;
}

function toggleOmitted(): void {
  emit("save", { text: props.line.corrected, omitted: !props.line.omitted });
}
</script>

<template>
  <div class="space-y-2">
    <div class="flex items-start gap-3">
      <span
        class="text-muted w-8 shrink-0 pt-0.5 text-right text-sm tabular-nums"
        >{{ label ?? "" }}</span
      >
      <div class="min-w-0 flex-1 space-y-1">
        <p
          class="text-sm"
          :class="line.omitted ? 'text-dimmed line-through' : 'text-default'"
        >
          {{ line.text }}
        </p>
        <div class="flex flex-wrap items-center gap-2">
          <UBadge
            v-if="line.corrected"
            size="sm"
            color="info"
            variant="soft"
            :label="t('agreementsRecord.corrected')"
          />
          <UBadge
            v-if="line.omitted"
            size="sm"
            color="neutral"
            variant="soft"
            :label="t('agreementsRecord.omittedBadge')"
          />
        </div>
      </div>
      <div v-if="!readonly && !editing" class="flex shrink-0 gap-1">
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-pencil"
          :aria-label="t('agreementsRecord.edit')"
          :disabled="saving"
          @click="startEditing"
        />
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          :icon="line.omitted ? 'i-lucide-eye' : 'i-lucide-eye-off'"
          :aria-label="
            line.omitted
              ? t('agreementsRecord.include')
              : t('agreementsRecord.omit')
          "
          :loading="saving"
          @click="toggleOmitted"
        />
      </div>
    </div>

    <div v-if="editing" class="space-y-2 pl-11">
      <UTextarea
        v-model="draft"
        autoresize
        :rows="2"
        class="w-full"
        :aria-label="t('agreementsRecord.wording')"
      />
      <p class="text-muted text-xs">
        <template v-if="line.suffix">
          {{ t("agreementsRecord.suffixHint", { suffix: line.suffix }) }}
        </template>
        <template v-if="line.corrected">
          {{ t("agreementsRecord.proposal", { text: line.proposed }) }}
        </template>
      </p>
      <div class="flex flex-wrap justify-end gap-2">
        <UButton
          v-if="line.corrected"
          size="sm"
          color="neutral"
          variant="ghost"
          icon="i-lucide-rotate-ccw"
          :label="t('agreementsRecord.reset')"
          :disabled="saving"
          @click="reset"
        />
        <UButton
          size="sm"
          color="neutral"
          variant="outline"
          :label="t('common.cancel')"
          @click="editing = false"
        />
        <UButton
          size="sm"
          icon="i-lucide-save"
          :label="t('agreementsRecord.save')"
          :loading="saving"
          @click="save"
        />
      </div>
    </div>
  </div>
</template>
