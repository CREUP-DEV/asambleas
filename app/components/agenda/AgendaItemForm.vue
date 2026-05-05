<script setup lang="ts">
interface AgendaItemFormData {
  title: string;
}

const props = defineProps<{
  modelValue: AgendaItemFormData;
  loading?: boolean;
  isSubItem?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [AgendaItemFormData];
  submit: [];
  cancel: [];
}>();

const { t } = useI18n();

const title = computed({
  get: () => props.modelValue.title,
  set: (val: string) =>
    emit("update:modelValue", { ...props.modelValue, title: val }),
});
</script>

<template>
  <form class="flex items-end gap-2" @submit.prevent="emit('submit')">
    <UFormField :label="t('assembly.agenda.itemTitle')" class="flex-1">
      <UInput
        v-model="title"
        class="w-full"
        autofocus
        :placeholder="t('assembly.agenda.itemTitle')"
      />
    </UFormField>

    <div class="flex gap-1 pb-0.5">
      <UButton type="submit" color="primary" size="sm" :loading="props.loading">
        {{ t("common.save") }}
      </UButton>
      <UButton
        type="button"
        variant="ghost"
        color="neutral"
        size="sm"
        @click="emit('cancel')"
      >
        {{ t("common.cancel") }}
      </UButton>
    </div>
  </form>
</template>
