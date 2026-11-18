<script setup lang="ts">
/**
 * A speaking time as minutes and seconds, two fields under one legend.
 * The model is the total in seconds, as the fields read it (unclamped: the
 * caller clamps when it saves). `commit` fires when the focus leaves both
 * fields or on Enter, once the field's own value has been applied.
 */
const props = defineProps<{
  legend: string;
  description?: string;
  disabled?: boolean;
}>();
const emit = defineEmits<{ commit: [seconds: number] }>();
const model = defineModel<number>({ required: true });

const { t } = useI18n();

const minutes = ref(0);
const seconds = ref(0);
const total = () => minutes.value * 60 + seconds.value;

watch(
  model,
  (value) => {
    if (value === total()) return;
    minutes.value = Math.floor(value / 60);
    seconds.value = value % 60;
  },
  { immediate: true },
);

function setPart(part: "minutes" | "seconds", value: number | null): void {
  const next = Number.isFinite(value) ? Math.max(0, Math.round(value!)) : 0;
  if (part === "minutes") minutes.value = next;
  else seconds.value = next;
  model.value = total();
}

const group = useTemplateRef<HTMLFieldSetElement>("group");

/** After the field has applied what was typed (on its blur or Enter). */
function commitLater(): void {
  setTimeout(() => {
    if (group.value?.contains(document.activeElement)) return;
    emit("commit", total());
  });
}
function onEnter(): void {
  setTimeout(() => emit("commit", total()));
}

const descriptionId = useId();
</script>

<template>
  <fieldset
    ref="group"
    :aria-describedby="props.description ? descriptionId : undefined"
    @focusout="commitLater"
    @keydown.enter="onEnter"
  >
    <legend class="text-default text-sm">
      {{ props.legend }}
    </legend>
    <p v-if="props.description" :id="descriptionId" class="text-muted text-sm">
      {{ props.description }}
    </p>
    <div class="mt-1 flex items-center gap-2">
      <UInputNumber
        :model-value="minutes"
        :min="0"
        :max="60"
        :disabled="props.disabled"
        :aria-label="t('session.speakers.limitMinutesPart')"
        class="w-24"
        @update:model-value="setPart('minutes', $event)"
      />
      <span class="text-muted text-sm" aria-hidden="true">
        {{ t("session.speakers.limitMinutesPart") }}
      </span>
      <UInputNumber
        :model-value="seconds"
        :min="0"
        :max="59"
        :step="5"
        :step-snapping="false"
        :disabled="props.disabled"
        :aria-label="t('session.speakers.limitSecondsPart')"
        class="w-24"
        @update:model-value="setPart('seconds', $event)"
      />
      <span class="text-muted text-sm" aria-hidden="true">
        {{ t("session.speakers.limitSecondsPart") }}
      </span>
    </div>
  </fieldset>
</template>
