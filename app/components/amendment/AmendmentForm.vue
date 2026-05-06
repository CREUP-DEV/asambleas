<script setup lang="ts">
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
} from "~~/shared/constants/security";

const { t } = useI18n();

interface ExistingAmendment {
  id: string;
  justification: string;
  contentPatch: string;
  updatedAt: string | Date;
}

const props = defineProps<{
  assemblyId: string;
  itemId: string;
  docId: string;
  documentContent: string;
  existing?: ExistingAmendment;
}>();

const emit = defineEmits<{
  saved: [];
  cancel: [];
}>();

const toast = useToast();
const loading = ref(false);

const justification = ref(props.existing?.justification ?? "");
const content = ref(props.documentContent);
const justificationTouched = ref(false);

const justificationError = computed(() =>
  justificationTouched.value && !justification.value.trim()
    ? t("validation.justificationRequired")
    : undefined,
);

const isValid = computed(
  () =>
    justification.value.trim().length > 0 && content.value.trim().length > 0,
);

const mutationHeaders = () => {
  const csrfToken = useCookie(CSRF_COOKIE_NAME).value;
  return csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : undefined;
};

const getErrorMessage = (error: unknown) => {
  return (
    (error as { data?: { message?: string } })?.data?.message ??
    t("errors.serverError")
  );
};

async function save() {
  if (!isValid.value || loading.value) return;
  loading.value = true;

  try {
    const basePath = `/api/assemblies/${props.assemblyId}/agenda-items/${props.itemId}/documents/${props.docId}/amendments`;

    if (props.existing) {
      await $fetch(`${basePath}/${props.existing.id}`, {
        method: "PUT",
        body: {
          content: content.value,
          justification: justification.value,
          updatedAt:
            props.existing.updatedAt instanceof Date
              ? props.existing.updatedAt.toISOString()
              : props.existing.updatedAt,
        },
        headers: mutationHeaders(),
      });
      toast.add({
        title: t("amendment.updated"),
        color: "success",
      });
    } else {
      await $fetch(basePath, {
        method: "POST",
        body: {
          content: content.value,
          justification: justification.value,
        },
        headers: mutationHeaders(),
      });
      toast.add({
        title: t("amendment.created"),
        color: "success",
      });
    }

    emit("saved");
  } catch (error: unknown) {
    toast.add({
      title: getErrorMessage(error),
      color: "error",
    });
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <form class="space-y-4" @submit.prevent="save">
    <UFormField :label="t('amendment.content')">
      <DocumentRichTextEditor v-model="content" />
    </UFormField>

    <UFormField
      :label="t('amendment.justification')"
      :error="justificationError"
    >
      <UTextarea
        v-model="justification"
        :placeholder="t('amendment.justificationPlaceholder')"
        :rows="4"
        autoresize
        @blur="justificationTouched = true"
      />
    </UFormField>

    <div class="flex justify-end gap-2">
      <UButton
        color="neutral"
        variant="ghost"
        :label="t('common.cancel')"
        @click="emit('cancel')"
      />
      <UButton
        type="submit"
        :label="existing ? t('common.save') : t('amendment.create')"
        :loading="loading"
        :disabled="!isValid"
      />
    </div>
  </form>
</template>
