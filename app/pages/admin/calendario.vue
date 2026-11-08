<script setup lang="ts">
import {
  ALL_ASSEMBLY_TYPES,
  type AssemblyType,
} from "~~/shared/constants/assemblyTypes";
import { MILESTONE_KEYS, type MilestoneKey } from "~~/shared/constants/domain";
import type { CalendarRulesBody, CalendarRulesDto } from "~~/shared/types/api";
import {
  milestoneOffsetBefore,
  type CalendarRules,
  type MilestoneOffset,
} from "~~/shared/utils/calendar";
import {
  OFFSET_MAX,
  REGULATION_WINDOW_MAX_DAYS,
} from "~~/shared/utils/schemas/calendarRules";

/**
 * Calendar rules of each assembly type: the default deadlines that fill a
 * new calendar and the regulatory minimums the calendar check warns about.
 * They change with the regulations, so they live in the database
 * (GET/PUT /api/calendar-rules). Saving never moves the dates of existing
 * calendars; their warnings follow the new minimums at once.
 */
definePageMeta({
  middleware: ["admin"],
  // CALENDAR_RULES_PERMISSION (page meta must be a literal).
  adminAccess: ["assembly:manage"],
});

type Unit = "days" | "hours" | "months";
const UNITS: Unit[] = ["days", "hours", "months"];

interface OffsetField {
  /** Empty: no default or no minimum for this milestone. */
  amount: number | null;
  unit: Unit;
}

interface RulesForm {
  defaults: Record<MilestoneKey, OffsetField>;
  minimums: Record<MilestoneKey, OffsetField>;
  documentsWithConvocationBelow: OffsetField;
  regulationWindowDays: number | null;
}

type Column = "defaults" | "minimums";
const COLUMNS: Column[] = ["defaults", "minimums"];

const { t } = useI18n();
const toast = useToast();
const api = useApi();

useHead({ title: () => t("admin.calendarRules.title") });

const {
  data,
  status,
  error: loadError,
  refresh,
} = await useFetch<CalendarRulesDto[]>("/api/calendar-rules", {
  key: "admin-calendar-rules",
});

const selectedType = ref<AssemblyType>("AGO");
const typeItems = computed(() =>
  ALL_ASSEMBLY_TYPES.map((type) => ({
    label: t(`assembly.typesShort.${type}`),
    value: type,
  })),
);

const current = computed(
  () => data.value?.find((dto) => dto.type === selectedType.value) ?? null,
);

/** The tabs' model: switching type with unsaved edits asks first. */
const tabType = computed<AssemblyType>({
  get: () => selectedType.value,
  set: (type) => {
    if (type === selectedType.value) return;
    if (
      dirty.value &&
      import.meta.client &&
      !window.confirm(t("admin.calendarRules.switchConfirm"))
    ) {
      return;
    }
    selectedType.value = type;
  },
});

function fieldFrom(offset: MilestoneOffset | undefined): OffsetField {
  if (!offset) return { amount: null, unit: "days" };
  if ("months" in offset) return { amount: offset.months, unit: "months" };
  if ("hours" in offset) return { amount: offset.hours, unit: "hours" };
  return { amount: offset.days, unit: "days" };
}

function formFrom(rules: CalendarRules | undefined): RulesForm {
  const column = (offsets?: CalendarRules["defaults"]) =>
    Object.fromEntries(
      MILESTONE_KEYS.map((key) => [key, fieldFrom(offsets?.[key])]),
    ) as Record<MilestoneKey, OffsetField>;
  return {
    defaults: column(rules?.defaults),
    minimums: column(rules?.minimums),
    documentsWithConvocationBelow: fieldFrom(
      rules?.documentsWithConvocationBelow ?? undefined,
    ),
    regulationWindowDays: rules?.regulationWindowDays ?? null,
  };
}

function offsetOf(field: OffsetField): MilestoneOffset | null {
  if (field.amount === null || Number.isNaN(field.amount)) return null;
  const amount = Math.trunc(field.amount);
  if (field.unit === "months") return { months: amount };
  if (field.unit === "hours") return { hours: amount };
  return { days: amount };
}

function rulesOf(value: RulesForm): CalendarRules {
  const column = (fields: Record<MilestoneKey, OffsetField>) =>
    Object.fromEntries(
      MILESTONE_KEYS.flatMap((key) => {
        const offset = offsetOf(fields[key]);
        return offset ? [[key, offset]] : [];
      }),
    ) as CalendarRules["defaults"];
  return {
    defaults: column(value.defaults),
    minimums: column(value.minimums),
    documentsWithConvocationBelow: offsetOf(
      value.documentsWithConvocationBelow,
    ),
    regulationWindowDays: value.regulationWindowDays || null,
  };
}

const form = reactive<RulesForm>(formFrom(undefined));
const saving = ref(false);

function resetForm() {
  Object.assign(form, formFrom(current.value?.rules));
}
watch(current, resetForm, { immediate: true });

const dirty = computed(
  () =>
    current.value !== null &&
    JSON.stringify(rulesOf(form)) !==
      JSON.stringify(rulesOf(formFrom(current.value.rules))),
);

function isInvalidOffset(field: OffsetField): boolean {
  if (field.amount === null) return false;
  return (
    !Number.isInteger(field.amount) ||
    field.amount < 0 ||
    field.amount > OFFSET_MAX[field.unit]
  );
}

/** Field-level problems, keyed `${column}.${key}`, before sending. */
const invalid = computed(() => {
  const result = new Set<string>();
  for (const column of COLUMNS) {
    for (const key of MILESTONE_KEYS) {
      if (isInvalidOffset(form[column][key])) result.add(`${column}.${key}`);
    }
  }
  if (isInvalidOffset(form.documentsWithConvocationBelow)) {
    result.add("documentsWithConvocationBelow");
  }
  const days = form.regulationWindowDays;
  if (
    days !== null &&
    (!Number.isInteger(days) || days < 1 || days > REGULATION_WINDOW_MAX_DAYS)
  ) {
    result.add("regulationWindowDays");
  }
  return result;
});

const unitItems = computed(() =>
  UNITS.map((unit) => ({
    label: t(`admin.calendarRules.units.${unit}`),
    value: unit,
  })),
);

const fieldId = (column: Column, key: MilestoneKey, part: "amount" | "unit") =>
  `calendar-rule-${column}-${key}-${part}`;

/** Where a default falls after its minimum: the defaults would warn. */
const defaultBreaksMinimum = (key: MilestoneKey) => {
  const proposed = offsetOf(form.defaults[key]);
  const minimum = offsetOf(form.minimums[key]);
  if (!proposed || !minimum) return false;
  // Compare on a fixed reference start, in the assemblies' time zone.
  const start = new Date("2027-03-15T09:00:00.000Z");
  return (
    milestoneOffsetBefore(start, proposed).getTime() >
    milestoneOffsetBefore(start, minimum).getTime()
  );
};

async function save() {
  const dto = current.value;
  if (!dto || (dto.stored && !dirty.value) || invalid.value.size > 0) return;
  const body: CalendarRulesBody = {
    rules: rulesOf(form),
    updatedAt: dto.updatedAt,
  };
  saving.value = true;
  try {
    const updated = await api.send<CalendarRulesDto>(
      `/api/calendar-rules/${dto.type}`,
      { method: "PUT", body: { ...body } },
    );
    data.value = (data.value ?? []).map((item) =>
      item.type === updated.type ? updated : item,
    );
    toast.add({
      title: t("admin.calendarRules.saved"),
      color: "success",
      icon: "i-lucide-check",
    });
  } catch (error) {
    api.notifyError(error, "admin.calendarRules.saveError");
    if (api.isConflict(error)) await refresh();
  } finally {
    saving.value = false;
  }
}

onBeforeRouteLeave(() => {
  if (dirty.value && import.meta.client) {
    return window.confirm(t("admin.calendarRules.unsavedConfirm"));
  }
  return true;
});
</script>

<template>
  <UDashboardPanel id="admin-calendar-rules">
    <template #header>
      <UDashboardNavbar :title="t('admin.calendarRules.title')">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
      <UDashboardToolbar>
        <template #left>
          <UTabs
            v-model="tabType"
            :items="typeItems"
            :content="false"
            variant="link"
            :aria-label="t('admin.calendarRules.typeLabel')"
          />
        </template>
      </UDashboardToolbar>
    </template>

    <template #body>
      <div class="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <p class="text-muted max-w-prose text-sm">
          {{ t("admin.calendarRules.intro") }}
        </p>

        <UAlert
          v-if="loadError"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :title="t('admin.loadFailed')"
          :actions="[
            {
              label: t('admin.retry'),
              color: 'error',
              variant: 'outline',
              onClick: () => refresh(),
            },
          ]"
        />
        <p v-else-if="status === 'pending' && !data" class="text-muted text-sm">
          {{ t("admin.loading") }}
        </p>

        <form
          v-else-if="current"
          class="flex flex-col gap-6"
          novalidate
          @submit.prevent="save"
        >
          <UAlert
            v-if="!current.stored"
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :title="t('admin.calendarRules.notStoredTitle')"
            :description="t('admin.calendarRules.notStored')"
          />

          <UCard :ui="{ body: 'p-0 sm:p-0' }">
            <template #header>
              <h2 class="text-highlighted font-semibold">
                {{ t(`assembly.types.${current.type}`) }}
              </h2>
            </template>

            <div class="overflow-x-auto">
              <table class="w-full text-sm">
                <caption class="sr-only">
                  {{
                    t("admin.calendarRules.tableCaption", {
                      type: t(`assembly.typesShort.${current.type}`),
                    })
                  }}
                </caption>
                <thead>
                  <tr class="border-default border-b text-left">
                    <th scope="col" class="px-4 py-2 font-medium">
                      {{ t("admin.calendarRules.milestone") }}
                    </th>
                    <th
                      v-for="column in COLUMNS"
                      :key="column"
                      scope="col"
                      class="px-4 py-2 font-medium"
                    >
                      <span class="block">
                        {{ t(`admin.calendarRules.columns.${column}`) }}
                      </span>
                      <span class="text-muted block text-xs font-normal">
                        {{ t(`admin.calendarRules.columnHints.${column}`) }}
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="key in MILESTONE_KEYS"
                    :key="key"
                    class="border-default border-b last:border-b-0"
                  >
                    <th scope="row" class="px-4 py-3 text-left font-normal">
                      <span class="text-highlighted block">
                        {{ t(`calendar.milestones.${key}`) }}
                      </span>
                      <span
                        v-if="defaultBreaksMinimum(key)"
                        class="text-warning mt-1 flex items-center gap-1 text-xs"
                      >
                        <UIcon
                          name="i-lucide-triangle-alert"
                          class="size-3.5"
                          aria-hidden="true"
                        />
                        {{ t("admin.calendarRules.defaultAfterMinimum") }}
                      </span>
                    </th>
                    <td
                      v-for="column in COLUMNS"
                      :key="column"
                      class="px-4 py-3 align-top"
                    >
                      <div class="flex items-center gap-2">
                        <UInput
                          :id="fieldId(column, key, 'amount')"
                          v-model.number="form[column][key].amount"
                          type="number"
                          inputmode="numeric"
                          min="0"
                          :max="OFFSET_MAX[form[column][key].unit]"
                          step="1"
                          class="w-24"
                          :placeholder="t('admin.calendarRules.none')"
                          :color="
                            invalid.has(`${column}.${key}`)
                              ? 'error'
                              : undefined
                          "
                          :aria-invalid="invalid.has(`${column}.${key}`)"
                          :aria-label="
                            t('admin.calendarRules.amountLabel', {
                              column: t(
                                `admin.calendarRules.columns.${column}`,
                              ),
                              milestone: t(`calendar.milestones.${key}`),
                            })
                          "
                          @update:model-value="
                            (value: unknown) => {
                              if (value === '' || value === undefined)
                                form[column][key].amount = null;
                            }
                          "
                        />
                        <USelect
                          :id="fieldId(column, key, 'unit')"
                          v-model="form[column][key].unit"
                          :items="unitItems"
                          class="w-28"
                          :aria-label="
                            t('admin.calendarRules.unitLabel', {
                              column: t(
                                `admin.calendarRules.columns.${column}`,
                              ),
                              milestone: t(`calendar.milestones.${key}`),
                            })
                          "
                        />
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </UCard>

          <UCard>
            <fieldset class="space-y-1.5">
              <legend class="text-default text-sm font-medium">
                {{ t("admin.calendarRules.documentsWithConvocationBelow") }}
              </legend>
              <p class="text-muted text-sm">
                {{ t("admin.calendarRules.documentsWithConvocationHint") }}
              </p>
              <div class="flex items-center gap-2">
                <UInput
                  v-model.number="form.documentsWithConvocationBelow.amount"
                  type="number"
                  inputmode="numeric"
                  min="0"
                  :max="OFFSET_MAX[form.documentsWithConvocationBelow.unit]"
                  step="1"
                  class="w-24"
                  :placeholder="t('admin.calendarRules.none')"
                  :color="
                    invalid.has('documentsWithConvocationBelow')
                      ? 'error'
                      : undefined
                  "
                  :aria-invalid="invalid.has('documentsWithConvocationBelow')"
                  :aria-label="
                    t('admin.calendarRules.documentsWithConvocationAmount')
                  "
                  @update:model-value="
                    (value: unknown) => {
                      if (value === '' || value === undefined)
                        form.documentsWithConvocationBelow.amount = null;
                    }
                  "
                />
                <USelect
                  v-model="form.documentsWithConvocationBelow.unit"
                  :items="unitItems"
                  class="w-28"
                  :aria-label="
                    t('admin.calendarRules.documentsWithConvocationUnit')
                  "
                />
              </div>
            </fieldset>
          </UCard>

          <UCard>
            <UFormField
              :label="t('admin.calendarRules.regulationWindowDays')"
              :description="t('admin.calendarRules.regulationWindowHint')"
              :error="
                invalid.has('regulationWindowDays')
                  ? t('admin.calendarRules.regulationWindowInvalid', {
                      max: REGULATION_WINDOW_MAX_DAYS,
                    })
                  : undefined
              "
              name="regulationWindowDays"
            >
              <UInput
                v-model.number="form.regulationWindowDays"
                type="number"
                inputmode="numeric"
                min="1"
                :max="REGULATION_WINDOW_MAX_DAYS"
                step="1"
                class="w-24"
                :placeholder="t('admin.calendarRules.none')"
                @update:model-value="
                  (value: unknown) => {
                    if (value === '' || value === undefined)
                      form.regulationWindowDays = null;
                  }
                "
              />
            </UFormField>
          </UCard>

          <div class="flex flex-wrap items-center justify-end gap-2">
            <p class="text-muted me-auto text-xs">
              {{ t("admin.calendarRules.existingUnchanged") }}
            </p>
            <UButton
              color="neutral"
              variant="ghost"
              :label="t('admin.calendarRules.discard')"
              :disabled="!dirty || saving"
              @click="resetForm"
            />
            <UButton
              type="submit"
              icon="i-lucide-save"
              :label="t('admin.save')"
              :loading="saving"
              :disabled="(current.stored && !dirty) || invalid.size > 0"
            />
          </div>
        </form>
      </div>
    </template>
  </UDashboardPanel>
</template>
