<script setup lang="ts">
import type { CalendarDate } from "@internationalized/date";
import { parseDate } from "@internationalized/date";
import { ALL_ASSEMBLY_TYPES } from "~~/shared/constants/assemblyTypes";

interface AssemblyFormData {
  number: number | null;
  type: string;
  startDate: string;
  endDate: string;
  location: string;
}

/** What `UCalendar` emits in `range` mode while a pick is half done. */
interface AssemblyDateRange {
  start: CalendarDate | undefined;
  end: CalendarDate | undefined;
}

const props = defineProps<{
  modelValue: AssemblyFormData;
  loading?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [AssemblyFormData];
  submit: [];
}>();

const { t, locale } = useI18n();

// The acronym is what the field is wide enough to show, and it is how the rest
// of the app labels an assembly (`80.ª AGO`). The full name stays on the cards
// and the detail page.
const typeOptions = ALL_ASSEMBLY_TYPES.map((type) => ({
  label: type,
  value: type,
}));

/**
 * The model keeps the `YYYY-MM-DDTHH:mm` strings the parents already convert
 * with `new Date(...)`, so the day and the time are edited separately here and
 * recombined on the way out. Days live in local state rather than in the model
 * because a day picked before its time has no valid string to travel as.
 */
const days = shallowRef<AssemblyDateRange>({
  start: undefined,
  end: undefined,
});
const startTime = ref("");
const endTime = ref("");
const calendarOpen = ref(false);

const splitValue = (value: string) => {
  const [day = "", time = ""] = value.split("T");
  return { day, time: time.slice(0, 5) };
};

const toCalendarDate = (day: string) => {
  try {
    return day ? parseDate(day) : undefined;
  } catch {
    return undefined;
  }
};

const combine = (day: CalendarDate | undefined, time: string) =>
  day && time ? `${day.toString()}T${time}` : "";

const hydrate = () => {
  const start = splitValue(props.modelValue.startDate);
  const end = splitValue(props.modelValue.endDate);

  days.value = {
    start: toCalendarDate(start.day),
    end: toCalendarDate(end.day),
  };
  startTime.value = start.time;
  endTime.value = end.time;
};

hydrate();

// Re-hydrate only when the value arrives from outside, never on our own emit.
watch(
  () => [props.modelValue.startDate, props.modelValue.endDate],
  ([nextStart, nextEnd]) => {
    if (
      nextStart === combine(days.value.start, startTime.value) &&
      nextEnd === combine(days.value.end, endTime.value)
    ) {
      return;
    }
    hydrate();
  },
);

const push = () => {
  emit("update:modelValue", {
    ...props.modelValue,
    startDate: combine(days.value.start, startTime.value),
    endDate: combine(days.value.end, endTime.value),
  });
};

const onDaysChange = (value: AssemblyDateRange) => {
  days.value = value;

  // Picking the closing day ends the interaction, so the popover gets out of
  // the way instead of waiting for a click elsewhere.
  if (calendarOpen.value && value.start && value.end) {
    calendarOpen.value = false;
  }

  push();
};

const update = (field: keyof AssemblyFormData, value: unknown) => {
  emit("update:modelValue", { ...props.modelValue, [field]: value });
};

/** Fixed numeric mask so the trigger always matches the placeholder. */
const formatDay = (day: CalendarDate) =>
  `${String(day.day).padStart(2, "0")}/${String(day.month).padStart(2, "0")}/${day.year}`;

const daysLabel = computed(() => {
  const { start, end } = days.value;

  if (!start) {
    return t("assembly.datePlaceholder");
  }

  if (!end || start.compare(end) === 0) {
    return formatDay(start);
  }

  return t("assembly.dateRangeShort", {
    start: formatDay(start),
    end: formatDay(end),
  });
});
</script>

<template>
  <form class="space-y-4" @submit.prevent="emit('submit')">
    <div class="grid gap-4 sm:grid-cols-2">
      <UFormField :label="t('assembly.number')" required>
        <UInput
          type="number"
          :value="props.modelValue.number"
          min="1"
          class="w-full"
          @input="
            update(
              'number',
              ($event.target as HTMLInputElement).valueAsNumber || null,
            )
          "
        />
      </UFormField>

      <UFormField :label="t('assembly.type')" required>
        <USelectMenu
          :model-value="
            typeOptions.find((o) => o.value === props.modelValue.type)
          "
          :items="typeOptions"
          class="w-full"
          @update:model-value="
            (opt: { value: string }) => update('type', opt.value)
          "
        />
      </UFormField>
    </div>

    <UFormField :label="t('assembly.dates')" required>
      <UPopover v-model:open="calendarOpen">
        <!-- `outline` is what UInput and USelectMenu render, so the trigger
             sits on the same background as the rest of the form. -->
        <UButton
          color="neutral"
          variant="outline"
          icon="i-tabler-calendar"
          class="w-full justify-start"
          :label="daysLabel"
          :ui="{ label: days.start ? undefined : 'text-dimmed' }"
        />
        <template #content>
          <UCalendar
            :model-value="days"
            range
            :locale="locale"
            class="p-2"
            @update:model-value="
              (value: unknown) => onDaysChange(value as AssemblyDateRange)
            "
          />
        </template>
      </UPopover>
    </UFormField>

    <div class="grid gap-4 sm:grid-cols-2">
      <UFormField :label="t('assembly.startTime')" required>
        <UInput
          v-model="startTime"
          type="time"
          class="w-full"
          @update:model-value="push"
        />
      </UFormField>

      <UFormField :label="t('assembly.endTime')" required>
        <UInput
          v-model="endTime"
          type="time"
          class="w-full"
          @update:model-value="push"
        />
      </UFormField>
    </div>

    <UFormField :label="t('assembly.location')" required>
      <UInput
        :value="props.modelValue.location"
        :placeholder="t('assembly.locationPlaceholder')"
        class="w-full"
        @input="update('location', ($event.target as HTMLInputElement).value)"
      />
    </UFormField>

    <div class="flex justify-end gap-2 pt-2">
      <slot name="actions" />
      <UButton type="submit" color="primary" :loading="props.loading">
        {{ t("common.save") }}
      </UButton>
    </div>
  </form>
</template>
