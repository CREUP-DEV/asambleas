<script setup lang="ts">
import type { FormError } from "@nuxt/ui";
import { toZoned } from "@internationalized/date";
import type { CalendarDateTime } from "@internationalized/date";
import { ALL_ASSEMBLY_TYPES } from "~~/shared/constants/assemblyTypes";
import type { AssemblyType } from "~~/shared/constants/assemblyTypes";
import type {
  AssemblyCreateBody,
  AssemblyDto,
  AssemblyListDto,
  AssemblySummaryDto,
} from "~~/shared/types/api";
import { ASSEMBLY_LOCATION_MAX_LENGTH } from "~~/shared/utils/schemas/assembly";
import { assemblyPath } from "~/components/shell/Navigation.vue";

/**
 * Creates an assembly (`assembly:create`). Dates are typed as Madrid wall
 * time, whatever the device's time zone, and sent as ISO instants. On
 * success it emits `created` and, unless `navigate` is false, opens it.
 */
const props = withDefaults(defineProps<{ navigate?: boolean }>(), {
  navigate: true,
});

const open = defineModel<boolean>("open", { default: false });

const emit = defineEmits<{ created: [assembly: AssemblyDto] }>();

const { t } = useI18n();
const localePath = useLocalePath();
const toast = useToast();
const api = useApi();

interface FormState {
  type: AssemblyType;
  number: number | null;
  location: string;
  applyDefaultCalendar: boolean;
}

const state = reactive<FormState>({
  type: "AGO",
  number: null,
  location: "",
  applyDefaultCalendar: true,
});

// Date objects of @internationalized/date use private class fields, which
// break behind a reactive proxy: keep them in shallow refs.
const start = shallowRef<CalendarDateTime>();
const end = shallowRef<CalendarDateTime>();

const formRef = useTemplateRef("createForm");
const saving = ref(false);
const numberTouched = ref(false);
const suggesting = ref(false);
let suggestionToken = 0;

const typeItems = computed(() =>
  ALL_ASSEMBLY_TYPES.map((type) => ({
    label: `${type} · ${t(`assemblies.types.${type}`)}`,
    value: type,
  })),
);

function reset(): void {
  Object.assign(state, {
    type: "AGO",
    number: null,
    location: "",
    applyDefaultCalendar: true,
  } satisfies FormState);
  start.value = undefined;
  end.value = undefined;
  numberTouched.value = false;
}

/** Proposes the next number of the type, unless the user typed one. */
async function suggestNumber(): Promise<void> {
  const token = ++suggestionToken;
  suggesting.value = true;
  try {
    const list = await api.get<AssemblyListDto>("/api/assemblies", {
      type: state.type,
      page: 1,
    });
    if (token !== suggestionToken || numberTouched.value) return;
    const highest = list.items.reduce(
      (max: number, item: AssemblySummaryDto) =>
        item.type === state.type ? Math.max(max, item.number) : max,
      0,
    );
    state.number = highest + 1;
  } catch {
    // The suggestion is a convenience; the user can type the number.
  } finally {
    if (token === suggestionToken) suggesting.value = false;
  }
}

watch(open, (isOpen) => {
  if (!isOpen) return;
  reset();
  void suggestNumber();
});

watch(
  () => state.type,
  () => {
    if (open.value && !numberTouched.value) void suggestNumber();
  },
);

function onNumberInput(value: number | null): void {
  numberTouched.value = true;
  state.number = value;
}

// The end usually falls on the same or a later day: start from the start.
watch(start, (value) => {
  if (value && !end.value) end.value = value;
});

function toIso(value: CalendarDateTime): string {
  return toZoned(value, APP_TIME_ZONE).toAbsoluteString();
}

function validate(value: Partial<FormState>): FormError[] {
  const errors: FormError[] = [];
  if (!value.type) {
    errors.push({
      name: "type",
      message: t("assemblies.create.errors.required"),
    });
  }
  const number = value.number;
  if (number === null || number === undefined) {
    errors.push({
      name: "number",
      message: t("assemblies.create.errors.required"),
    });
  } else if (!Number.isInteger(number) || number < 1 || number > 9999) {
    errors.push({
      name: "number",
      message: t("assemblies.create.errors.number"),
    });
  }
  if (!start.value) {
    errors.push({
      name: "start",
      message: t("assemblies.create.errors.required"),
    });
  }
  if (!end.value) {
    errors.push({
      name: "end",
      message: t("assemblies.create.errors.required"),
    });
  } else if (start.value && end.value.compare(start.value) < 0) {
    errors.push({
      name: "end",
      message: t("assemblies.create.errors.endBeforeStart"),
    });
  }
  const location = value.location?.trim() ?? "";
  if (!location) {
    errors.push({
      name: "location",
      message: t("assemblies.create.errors.required"),
    });
  } else if (location.length > ASSEMBLY_LOCATION_MAX_LENGTH) {
    errors.push({
      name: "location",
      message: t("assemblies.create.errors.tooLong"),
    });
  }
  return errors;
}

async function submit(): Promise<void> {
  if (!start.value || !end.value || state.number === null) return;
  const body: AssemblyCreateBody = {
    type: state.type,
    number: state.number,
    startDate: toIso(start.value),
    endDate: toIso(end.value),
    location: state.location.trim(),
    applyDefaultCalendar: state.applyDefaultCalendar,
  };

  saving.value = true;
  try {
    const created = await api.send<AssemblyDto>("/api/assemblies", { body });
    toast.add({
      title: t("assemblies.create.created", { assembly: created.label }),
      color: "success",
      icon: "i-lucide-check",
    });
    emit("created", created);
    open.value = false;
    if (props.navigate) {
      await navigateTo(localePath(assemblyPath(created.slug)));
    }
  } catch (error) {
    if (api.errorStatus(error) === 409) {
      formRef.value?.setErrors(
        [
          {
            name: "number",
            message: t("assemblies.create.errors.duplicate", {
              type: body.type,
              number: body.number,
            }),
          },
        ],
        "number",
      );
    } else {
      api.notifyError(error, "assemblies.create.errors.failed");
    }
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('assemblies.create.title')"
    :description="t('assemblies.create.description')"
    :dismissible="!saving"
    :ui="{ content: 'sm:max-w-xl' }"
  >
    <template #body>
      <UForm
        id="assembly-create-form"
        ref="createForm"
        :state="state"
        :validate="validate"
        :validate-on="['blur', 'change']"
        class="space-y-4"
        @submit="submit"
      >
        <div class="grid gap-4 sm:grid-cols-[1fr_9rem]">
          <UFormField :label="t('assemblies.create.type')" name="type" required>
            <USelect v-model="state.type" :items="typeItems" class="w-full" />
          </UFormField>

          <UFormField
            :label="t('assemblies.create.number')"
            name="number"
            required
            :help="suggesting ? t('assemblies.create.suggesting') : undefined"
          >
            <UInputNumber
              :model-value="state.number"
              :min="1"
              :max="9999"
              :format-options="{ useGrouping: false }"
              class="w-full"
              @update:model-value="onNumberInput"
            />
          </UFormField>
        </div>

        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField
            :label="t('assemblies.create.start')"
            name="start"
            required
          >
            <UInputDate
              v-model="start"
              granularity="minute"
              :hour-cycle="24"
              class="w-full"
            />
          </UFormField>

          <UFormField :label="t('assemblies.create.end')" name="end" required>
            <UInputDate
              v-model="end"
              granularity="minute"
              :hour-cycle="24"
              class="w-full"
            />
          </UFormField>
        </div>
        <p class="text-muted -mt-2 text-xs">
          {{ t("assemblies.create.timeZoneHelp") }}
        </p>

        <UFormField
          :label="t('assemblies.create.location')"
          name="location"
          required
        >
          <UInput
            v-model="state.location"
            :placeholder="t('assemblies.create.locationPlaceholder')"
            :maxlength="ASSEMBLY_LOCATION_MAX_LENGTH"
            autocomplete="off"
            class="w-full"
          />
        </UFormField>

        <UFormField name="applyDefaultCalendar">
          <USwitch
            v-model="state.applyDefaultCalendar"
            :label="t('assemblies.create.defaultCalendar')"
            :description="t('assemblies.create.defaultCalendarHelp')"
          />
        </UFormField>
      </UForm>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :disabled="saving"
          @click="open = false"
        >
          {{ t("assemblies.create.cancel") }}
        </UButton>
        <UButton
          type="submit"
          form="assembly-create-form"
          icon="i-lucide-plus"
          :loading="saving"
        >
          {{ t("assemblies.create.submit") }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
