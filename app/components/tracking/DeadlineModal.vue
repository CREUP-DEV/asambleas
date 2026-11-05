<script setup lang="ts">
import type {
  DocumentDto,
  DocumentSummaryDto,
  DocumentUpdateBody,
} from "~~/shared/types/api";

/**
 * "Cambiar plazo" ("Poner plazo" when there is none yet): the internal
 * deadline of an expected document (PUT .../documents/[document] with dueAt
 * and updatedAt). It can also be removed. A date already past is allowed,
 * with a warning, since it marks the document as overdue at once. Emits
 * `saved` with the updated document.
 */
const props = defineProps<{
  /** "/api/assemblies/<id>" */
  apiBase: string;
  document: DocumentSummaryDto | null;
}>();

const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{ saved: [document: DocumentDto]; conflict: [] }>();

const { t } = useI18n();
const api = useApi();
const toast = useToast();
const now = useAppNow();

const dueAt = ref<string | null>(null);
const saving = ref<"save" | "clear" | null>(null);

// The last document shown, so the title and the description do not change
// while the modal closes (the parent clears `document` at once).
const shown = ref<DocumentSummaryDto | null>(props.document);
watch(
  () => props.document,
  (value) => {
    if (value) shown.value = value;
  },
);
const hasDeadline = computed(() => Boolean(shown.value?.dueAt));
/** Lower bound of the picker: typed dates may still be earlier. */
const minDue = computed(() => new Date(now.value).toISOString());
const inPast = computed(
  () => dueAt.value !== null && new Date(dueAt.value).getTime() <= now.value,
);

watch(
  [open, () => props.document?.id],
  ([isOpen]) => {
    if (isOpen) dueAt.value = props.document?.dueAt ?? null;
  },
  { immediate: true },
);

const unchanged = computed(
  () => (props.document?.dueAt ?? null) === (dueAt.value ?? null),
);

async function save(value: string | null, mode: "save" | "clear") {
  const document = props.document;
  if (!document || saving.value) return;
  saving.value = mode;
  try {
    const body: DocumentUpdateBody = {
      dueAt: value,
      updatedAt: document.updatedAt,
    };
    const updated = await api.send<DocumentDto>(
      `${props.apiBase}/documents/${encodeURIComponent(document.id)}`,
      { method: "PUT", body },
    );
    emit("saved", updated);
    open.value = false;
    toast.add({
      title:
        value === null
          ? t("tracking.deadline.cleared", { title: document.title })
          : t("tracking.deadline.saved", { title: document.title }),
      color: "success",
      icon: "i-lucide-calendar-check",
    });
  } catch (error) {
    api.notifyError(error, "tracking.deadline.error");
    if (api.isConflict(error)) {
      open.value = false;
      emit("conflict");
    }
  } finally {
    saving.value = null;
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="
      hasDeadline
        ? t('tracking.deadline.title')
        : t('tracking.deadline.titleNew')
    "
    :description="shown?.title"
    :dismissible="saving === null"
  >
    <template #body>
      <UFormField
        :label="t('tracking.deadline.label')"
        :help="t('tracking.deadline.help')"
      >
        <DocumentDateTimeInput v-model="dueAt" :min="minDue" />
      </UFormField>
      <p
        v-if="inPast && !unchanged"
        class="text-warning mt-2 flex items-start gap-1.5 text-sm"
        role="status"
      >
        <UIcon
          name="i-lucide-triangle-alert"
          class="mt-0.5 size-4 shrink-0"
          aria-hidden="true"
        />
        <span>{{ t("tracking.deadline.pastWarning") }}</span>
      </p>
    </template>
    <template #footer>
      <div class="flex w-full flex-wrap items-center justify-between gap-2">
        <UButton
          v-if="hasDeadline"
          color="neutral"
          variant="ghost"
          icon="i-lucide-calendar-x"
          :label="t('tracking.deadline.clear')"
          :loading="saving === 'clear'"
          :disabled="saving !== null"
          @click="save(null, 'clear')"
        />
        <span v-else />
        <div class="flex flex-wrap gap-2">
          <UButton
            color="neutral"
            variant="outline"
            :label="t('common.cancel')"
            :disabled="saving !== null"
            @click="open = false"
          />
          <UButton
            icon="i-lucide-calendar-check"
            :label="
              hasDeadline
                ? t('tracking.deadline.save')
                : t('tracking.deadline.saveNew')
            "
            :loading="saving === 'save'"
            :disabled="saving !== null || unchanged || dueAt === null"
            @click="save(dueAt, 'save')"
          />
        </div>
      </div>
    </template>
  </UModal>
</template>
