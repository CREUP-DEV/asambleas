<script setup lang="ts">
import type { AgendaTreeNode } from "~/utils/agendaTree";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
} from "~~/shared/constants/security";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";

const props = defineProps<{
  item: AgendaTreeNode;
  assemblyId: string;
  canManage: boolean;
}>();

const emit = defineEmits<{
  updated: [AgendaTreeNode];
}>();

const { t } = useI18n();
const toast = useToast();

const toDatetimeLocal = (d: string | Date | null) => {
  if (!d) return "";
  const date = new Date(d);
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16);
};

const allowDocSub = ref(props.item.allowDocumentSubmission);
const docSubDeadline = ref(
  toDatetimeLocal(props.item.documentSubmissionDeadline),
);
const allowAmend = ref(props.item.allowAmendments);
const amendDeadline = ref(toDatetimeLocal(props.item.amendmentDeadline));
const saving = ref(false);

const { hasPermission } = usePermissions();
const canEdit = computed(
  () => props.canManage && hasPermission(PERMISSION_KEYS.ASSEMBLY_MANAGE),
);

const save = async () => {
  saving.value = true;
  try {
    const csrfToken = useCookie(CSRF_COOKIE_NAME).value;
    const updated = await $fetch<AgendaTreeNode>(
      `/api/assemblies/${props.assemblyId}/agenda-items/${props.item.id}`,
      {
        method: "PUT",
        body: {
          allowDocumentSubmission: allowDocSub.value,
          documentSubmissionDeadline: docSubDeadline.value
            ? new Date(docSubDeadline.value).toISOString()
            : null,
          allowAmendments: allowAmend.value,
          amendmentDeadline: amendDeadline.value
            ? new Date(amendDeadline.value).toISOString()
            : null,
          updatedAt: new Date(props.item.updatedAt).toISOString(),
        },
        headers: csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : undefined,
      },
    );
    toast.add({ title: t("assembly.agenda.itemUpdated"), color: "success" });
    emit("updated", { ...props.item, ...updated });
  } catch {
    toast.add({ title: t("errors.serverError"), color: "error" });
  } finally {
    saving.value = false;
  }
};
</script>

<template>
  <div class="space-y-4 p-4">
    <h3 class="font-medium">
      {{ t("assembly.agenda.settings") }}
    </h3>

    <div class="space-y-3">
      <div class="flex items-center justify-between gap-2">
        <label class="text-sm">
          {{ t("assembly.agenda.allowDocumentSubmission") }}
        </label>
        <UToggle v-model="allowDocSub" :disabled="!canEdit" />
      </div>

      <UFormField
        v-if="allowDocSub"
        :label="t('assembly.agenda.documentSubmissionDeadline')"
      >
        <UInput
          v-model="docSubDeadline"
          type="datetime-local"
          :disabled="!canEdit"
          class="w-full"
        />
      </UFormField>

      <div class="flex items-center justify-between gap-2">
        <label class="text-sm">
          {{ t("assembly.agenda.allowAmendments") }}
        </label>
        <UToggle v-model="allowAmend" :disabled="!canEdit" />
      </div>

      <UFormField
        v-if="allowAmend"
        :label="t('assembly.agenda.amendmentDeadline')"
      >
        <UInput
          v-model="amendDeadline"
          type="datetime-local"
          :disabled="!canEdit"
          class="w-full"
        />
      </UFormField>
    </div>

    <div v-if="canEdit" class="flex justify-end">
      <UButton size="sm" color="primary" :loading="saving" @click="save">
        {{ t("common.save") }}
      </UButton>
    </div>
  </div>
</template>
