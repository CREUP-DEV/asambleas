<script setup lang="ts">
import type { RecordLine } from "~~/shared/utils/agreementsRecord";

/**
 * One line of the acta de acuerdos in the Secretaría's panel: what the
 * record prints, and its correction. The words replace the proposal while
 * the suffix («, por asentimiento») still follows the vote; the line may
 * also be left out. Saving emits the correction; null words and not
 * omitted take it back.
 *
 * Below sm the actions go under the text with their names, so the text
 * keeps the width (M-148); from sm they are icons beside it, named by a
 * tooltip. The editor opens with the focus in it, and closing it or saving
 * gives the focus back to the button that was pressed (E-158).
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
/**
 * The actions show their names below sm: no tooltip there. Read only once
 * mounted, so the server and the hydrating client agree.
 */
const mounted = useMounted();
const smQuery = useMediaQuery("(min-width: 640px)");
const wide = computed(() => mounted.value && smQuery.value);

const editing = ref(false);
const draft = ref("");

const editButton = useTemplateRef<{ $el?: HTMLElement }>("editButton");
const omitButton = useTemplateRef<{ $el?: HTMLElement }>("omitButton");
/**
 * The button to give the focus back to: the pencil once the editor closes,
 * the eye once its save ends (it is disabled meanwhile, which drops the
 * focus). Only while nothing else took the focus.
 */
const returnTo = ref<"edit" | "omit" | null>(null);
watch(
  [returnTo, () => props.saving, editing],
  async ([target, saving, open]) => {
    if (!target || saving || open) return;
    returnTo.value = null;
    await nextTick();
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    (target === "edit" ? editButton : omitButton).value?.$el?.focus();
  },
  { flush: "post" },
);

function startEditing(): void {
  draft.value = props.line.corrected ?? props.line.proposed;
  editing.value = true;
}

function close(): void {
  editing.value = false;
  returnTo.value = "edit";
}

function save(): void {
  const words = draft.value.trim();
  emit("save", {
    text: words && words !== props.line.proposed ? words : null,
    omitted: props.line.omitted,
  });
  close();
}

function reset(): void {
  emit("save", { text: null, omitted: props.line.omitted });
  close();
}

function toggleOmitted(): void {
  returnTo.value = "omit";
  emit("save", { text: props.line.corrected, omitted: !props.line.omitted });
}

const omitLabel = computed(() =>
  props.line.omitted
    ? t("agreementsRecord.include")
    : t("agreementsRecord.omit"),
);
/** Named below sm; an icon of 28 px with its name read out from sm. */
const actionUi = { label: "sm:sr-only", base: "sm:p-1.5" };
</script>

<template>
  <div class="space-y-2">
    <div
      class="grid grid-cols-[1.5rem_minmax(0,1fr)] items-start gap-x-2 gap-y-1.5 sm:grid-cols-[2rem_minmax(0,1fr)_auto] sm:gap-x-3"
    >
      <span class="text-muted pt-0.5 text-right text-sm tabular-nums">{{
        label ?? ""
      }}</span>
      <div class="min-w-0 space-y-1">
        <p
          class="text-sm"
          :class="line.omitted ? 'text-dimmed line-through' : 'text-default'"
        >
          {{ line.text }}
        </p>
        <div
          v-if="line.corrected || line.omitted"
          class="flex flex-wrap items-center gap-2"
        >
          <UBadge
            v-if="line.corrected"
            size="md"
            color="info"
            variant="soft"
            :label="t('agreementsRecord.corrected')"
          />
          <UBadge
            v-if="line.omitted"
            size="md"
            color="neutral"
            variant="soft"
            :label="t('agreementsRecord.omittedBadge')"
          />
        </div>
      </div>
      <div
        v-if="!readonly && !editing"
        class="col-start-2 flex flex-wrap gap-2 sm:col-start-3 sm:row-start-1 sm:gap-1"
      >
        <UTooltip
          :text="t('agreementsRecord.edit')"
          :disabled="!wide"
          :content="{ side: 'top' }"
        >
          <UButton
            ref="editButton"
            size="sm"
            color="neutral"
            variant="ghost"
            icon="i-lucide-pencil"
            :label="t('agreementsRecord.edit')"
            :ui="actionUi"
            :disabled="saving"
            @click="startEditing"
          />
        </UTooltip>
        <UTooltip
          :text="omitLabel"
          :disabled="!wide"
          :content="{ side: 'top' }"
        >
          <UButton
            ref="omitButton"
            size="sm"
            color="neutral"
            variant="ghost"
            :icon="line.omitted ? 'i-lucide-eye' : 'i-lucide-eye-off'"
            :label="omitLabel"
            :ui="actionUi"
            :loading="saving"
            @click="toggleOmitted"
          />
        </UTooltip>
      </div>
    </div>

    <div v-if="editing" class="space-y-2 ps-8 sm:ps-11">
      <UTextarea
        v-model="draft"
        autoresize
        autofocus
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
          @click="close"
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
