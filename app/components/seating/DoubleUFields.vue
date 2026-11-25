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
    /** The total under the fields; the gallery says it in its own footer. */
    showCapacity?: boolean;
  }>(),
  { disabled: false, compact: false, showCapacity: true },
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

/**
 * − and + fit a finger below sm (M-098): 40 px there, 32 px from sm up.
 * The media query is read on the client during setup, before hydration, so
 * the size waits for mount: the server and the hydrating client both render
 * xl, and the switch to md after mount is a real change Vue patches.
 */
const wide = useMediaQuery("(min-width: 640px)");
const mounted = useMounted();
const compactSteppers = computed(() => mounted.value && wide.value);
</script>

<template>
  <div class="space-y-3">
    <div
      class="grid gap-3"
      :class="compact ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2'"
    >
      <!-- The label grows, so the fields of a row line up at its foot even
           when one label takes two lines (E-110). -->
      <UFormField
        v-for="field in DOUBLE_U_FIELDS"
        :key="field"
        :label="t(`seating.doubleU.fields.${field}`)"
        :description="field === 'gap' ? t('seating.doubleU.unitCm') : undefined"
        :error="
          problem && problem.field === field
            ? t(problem.key, problem.values)
            : undefined
        "
        :class="field === 'seatsPerTable' && !compact ? 'sm:col-span-2' : ''"
        :ui="{ root: 'flex flex-col', wrapper: 'flex-1' }"
      >
        <URadioGroup
          v-if="field === 'seatsPerTable'"
          :model-value="local.seatsPerTable"
          :items="seatOptions"
          orientation="horizontal"
          variant="card"
          :aria-label="t('seating.doubleU.fields.seatsPerTable')"
          :ui="{ item: 'flex-1', label: 'whitespace-nowrap' }"
          :disabled="disabled"
          @update:model-value="(value) => set('seatsPerTable', Number(value))"
        />
        <UInputNumber
          v-else
          :model-value="local[field]"
          :min="DOUBLE_U_LIMITS[field].min"
          :max="DOUBLE_U_LIMITS[field].max"
          :step="field === 'gap' ? DOUBLE_U_LIMITS.gap.step : 1"
          :size="compactSteppers ? 'md' : 'xl'"
          :disabled="disabled"
          class="w-full"
          @update:model-value="(value) => set(field, value)"
        />
      </UFormField>
    </div>
    <p v-if="showCapacity" class="text-muted text-sm">
      {{ t("seating.doubleU.capacity", { count: capacity }, capacity) }}
    </p>
  </div>
</template>
