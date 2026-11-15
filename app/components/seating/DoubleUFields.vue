<script setup lang="ts">
import type { DoubleUParams } from "~~/shared/utils/seating/layout";
import {
  DOUBLE_U_LIMITS,
  doubleUCapacity,
} from "~~/shared/utils/seating/templates";
import { DOUBLE_U_FIELDS, doubleUProblem } from "./-model";

/**
 * The Doble U's few numbers (docs/seating-plan.md, section 4): tables on
 * each arm and on the base of each U, seats per table, seats at the Mesa
 * and the gap between the Us. Each field keeps to its limits; the rule
 * that ties two of them (the outer base two tables wider than the inner)
 * is said under the field at fault. Emits only numbers that make a room,
 * and says through `valid` whether what is typed makes one: while it does
 * not, the form's save waits (it would save the last numbers that did,
 * not the ones on screen).
 */

const props = withDefaults(
  defineProps<{
    modelValue: DoubleUParams;
    disabled?: boolean;
    /** One column, for the side panel. */
    compact?: boolean;
  }>(),
  { disabled: false, compact: false },
);

const emit = defineEmits<{
  "update:modelValue": [params: DoubleUParams];
}>();

/** Whether the numbers on screen make a room (v-model:valid). */
const valid = defineModel<boolean>("valid", { default: true });

const { t } = useI18n();

/** What is being typed, which may not make a room yet. */
const local = ref<DoubleUParams>({ ...props.modelValue });
watch(
  () => props.modelValue,
  (value) => {
    local.value = { ...value };
  },
);

const problem = computed(() => doubleUProblem(local.value));
watch(
  problem,
  (value) => {
    valid.value = !value;
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  // Gone with its form part: nothing on screen holds a save back.
  valid.value = true;
});

function set(field: keyof DoubleUParams, value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return;
  local.value = { ...local.value, [field]: value } as DoubleUParams;
  if (!doubleUProblem(local.value)) emit("update:modelValue", local.value);
}

const seatOptions = computed(() =>
  [2, 3].map((value) => ({
    value,
    label: t("seating.doubleU.seatsOption", { count: value }, value),
  })),
);

const capacity = computed(() => doubleUCapacity(local.value));
</script>

<template>
  <div class="space-y-3">
    <div
      class="grid gap-3"
      :class="compact ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2'"
    >
      <UFormField
        v-for="field in DOUBLE_U_FIELDS"
        :key="field"
        :label="t(`seating.doubleU.fields.${field}`)"
        :hint="field === 'gap' ? t('seating.doubleU.unitCm') : undefined"
        :error="
          problem && problem.field === field
            ? t(problem.key, problem.values)
            : undefined
        "
      >
        <URadioGroup
          v-if="field === 'seatsPerTable'"
          :model-value="local.seatsPerTable"
          :items="seatOptions"
          orientation="horizontal"
          :disabled="disabled"
          @update:model-value="(value) => set('seatsPerTable', Number(value))"
        />
        <UInputNumber
          v-else
          :model-value="local[field]"
          :min="DOUBLE_U_LIMITS[field].min"
          :max="DOUBLE_U_LIMITS[field].max"
          :step="field === 'gap' ? DOUBLE_U_LIMITS.gap.step : 1"
          :disabled="disabled"
          class="w-full"
          @update:model-value="(value) => set(field, value)"
        />
      </UFormField>
    </div>
    <p
      v-if="problem && problem.field === null"
      class="text-error text-sm"
      role="alert"
    >
      {{ t(problem.key, problem.values) }}
    </p>
    <p class="text-muted text-sm">
      {{ t("seating.doubleU.capacity", { count: capacity }, capacity) }}
    </p>
  </div>
</template>
