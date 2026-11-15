<script setup lang="ts">
import type { TreatedLock } from "./-model";

/**
 * The «Tratado» box of a row: ticked when the row was treated. The Mesa
 * (`editable`) ticks or clears it right there; everyone else reads it, as
 * does the Mesa when it counts by itself (`lock`), whose reason shows in a
 * tooltip and is the box's description for screen readers. `label` names
 * the row ("Tratado: 3.1. Informe"); `feminine` words the reason for an
 * amendment. While a change is on its way (`saving`) the box shows it and
 * stays enabled, so the focus stays on it; the page ignores a second click
 * until the answer comes.
 */
const props = defineProps<{
  treated: boolean;
  lock: TreatedLock;
  editable: boolean;
  saving?: boolean;
  label: string;
  feminine?: boolean;
}>();

const emit = defineEmits<{ change: [value: boolean] }>();

const { t } = useI18n();
const reasonId = useId();

/** Why the Mesa cannot clear it; nothing for those who only read it. */
const reason = computed(() => {
  if (!props.editable || !props.lock) return "";
  if (props.lock === "result") return t("controlSheet.panel.treatedByResult");
  return props.feminine
    ? t("controlSheet.panel.treatedAutoAmendment")
    : t("controlSheet.panel.treatedAuto");
});

function onUpdate(value: boolean | "indeterminate"): void {
  emit("change", value === true);
}
</script>

<template>
  <UTooltip :text="reason">
    <span class="inline-flex items-center">
      <UCheckbox
        :model-value="treated"
        :disabled="!editable || lock !== null"
        :aria-label="label"
        :aria-describedby="reason ? reasonId : undefined"
        :aria-busy="saving || undefined"
        @update:model-value="onUpdate"
      />
      <span v-if="reason" :id="reasonId" class="sr-only">{{ reason }}</span>
    </span>
  </UTooltip>
</template>
