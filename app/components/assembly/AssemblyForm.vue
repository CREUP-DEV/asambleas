<script setup lang="ts">
import { ALL_ASSEMBLY_TYPES } from "~~/shared/constants/assemblyTypes";

interface AssemblyFormData {
  number: number | null;
  type: string;
  startDate: string;
  endDate: string;
  location: string;
}

const props = defineProps<{
  modelValue: AssemblyFormData;
  loading?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [AssemblyFormData];
  submit: [];
}>();

const { t } = useI18n();

const form = computed({
  get: () => props.modelValue,
  set: (val) => emit("update:modelValue", val),
});

// The acronym is what the field is wide enough to show, and it is how the rest
// of the app labels an assembly (`80.ª AGO`). The full name stays on the cards
// and the detail page.
const typeOptions = ALL_ASSEMBLY_TYPES.map((type) => ({
  label: type,
  value: type,
}));

const update = (field: keyof AssemblyFormData, value: unknown) => {
  emit("update:modelValue", { ...props.modelValue, [field]: value });
};
</script>

<template>
  <form class="space-y-4" @submit.prevent="emit('submit')">
    <UFormField :label="t('assembly.number')" required>
      <UInput
        type="number"
        :value="form.number"
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
        :model-value="typeOptions.find((o) => o.value === form.type)"
        :items="typeOptions"
        class="w-full"
        @update:model-value="
          (opt: { value: string }) => update('type', opt.value)
        "
      />
    </UFormField>

    <div class="grid grid-cols-2 gap-4">
      <UFormField :label="t('assembly.startDate')" required>
        <UInput
          type="datetime-local"
          :value="form.startDate"
          class="w-full"
          @input="
            update('startDate', ($event.target as HTMLInputElement).value)
          "
        />
      </UFormField>

      <UFormField :label="t('assembly.endDate')" required>
        <UInput
          type="datetime-local"
          :value="form.endDate"
          class="w-full"
          @input="update('endDate', ($event.target as HTMLInputElement).value)"
        />
      </UFormField>
    </div>

    <UFormField :label="t('assembly.location')" required>
      <UInput
        :value="form.location"
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
