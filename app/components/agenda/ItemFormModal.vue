<script setup lang="ts">
import { z } from "zod/v4";
import type { FormSubmitEvent } from "@nuxt/ui";
import type { AgendaItemBody, AgendaItemDto } from "~~/shared/types/api";
import {
  AGENDA_DESCRIPTION_MAX_LENGTH,
  AGENDA_TITLE_MAX_LENGTH,
} from "~~/shared/utils/schemas/assembly";

/**
 * Creates or edits an agenda item. With `item` it edits it (PUT, with
 * optimistic locking); otherwise it creates one under `parent` (or as a root
 * item). Emits `saved` with the stored item, or `conflict` after a 409 so the
 * page refetches.
 */
const props = withDefaults(
  defineProps<{
    apiBase: string;
    item?: AgendaItemDto | null;
    /** Parent of a new item, with its number, for the subtitle. */
    parent?: { id: string; title: string; number: string } | null;
  }>(),
  { item: null, parent: null },
);

const open = defineModel<boolean>("open", { default: false });

const emit = defineEmits<{
  saved: [item: AgendaItemDto, created: boolean];
  conflict: [];
}>();

const { t } = useI18n();
const api = useApi();

const schema = computed(() =>
  z.object({
    title: z
      .string()
      .trim()
      .min(1, t("agenda.form.titleRequired"))
      .max(
        AGENDA_TITLE_MAX_LENGTH,
        t("agenda.form.tooLong", { max: AGENDA_TITLE_MAX_LENGTH }),
      ),
    description: z
      .string()
      .max(
        AGENDA_DESCRIPTION_MAX_LENGTH,
        t("agenda.form.tooLong", { max: AGENDA_DESCRIPTION_MAX_LENGTH }),
      ),
    acceptsSubmissions: z.boolean(),
  }),
);

type ItemForm = z.output<typeof schema.value>;

const state = reactive<ItemForm>({
  title: "",
  description: "",
  acceptsSubmissions: false,
});
const saving = ref(false);

watch(
  open,
  (isOpen) => {
    if (!isOpen) return;
    state.title = props.item?.title ?? "";
    state.description = props.item?.description ?? "";
    state.acceptsSubmissions = props.item?.acceptsSubmissions ?? false;
  },
  { immediate: true },
);

const editing = computed(() => Boolean(props.item));
const title = computed(() =>
  editing.value
    ? t("agenda.form.editTitle")
    : props.parent
      ? t("agenda.form.newSubItemTitle")
      : t("agenda.form.newItemTitle"),
);
const description = computed(() =>
  props.parent && !editing.value
    ? t("agenda.form.parentHint", {
        number: props.parent.number,
        title: props.parent.title,
      })
    : t("agenda.form.hint"),
);

async function onSubmit(event: FormSubmitEvent<ItemForm>) {
  saving.value = true;
  const body: AgendaItemBody = {
    title: event.data.title,
    description: event.data.description.trim() || null,
    acceptsSubmissions: event.data.acceptsSubmissions,
  };
  try {
    if (props.item) {
      const saved = await api.send<AgendaItemDto>(
        `${props.apiBase}/agenda/${props.item.id}`,
        {
          method: "PUT",
          body: { ...body, updatedAt: props.item.updatedAt },
        },
      );
      emit("saved", saved, false);
    } else {
      const saved = await api.send<AgendaItemDto>(`${props.apiBase}/agenda`, {
        method: "POST",
        body: { ...body, parentId: props.parent?.id ?? null },
      });
      emit("saved", saved, true);
    }
    open.value = false;
  } catch (error) {
    api.notifyError(error, "agenda.form.saveError");
    if (api.isConflict(error)) {
      open.value = false;
      emit("conflict");
    }
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="title"
    :description="description"
    :dismissible="!saving"
  >
    <template #body>
      <UForm
        id="agenda-item-form"
        :schema="schema"
        :state="state"
        class="space-y-4"
        @submit="onSubmit"
      >
        <UFormField :label="t('agenda.form.title')" name="title" required>
          <UInput
            v-model="state.title"
            :maxlength="AGENDA_TITLE_MAX_LENGTH"
            autofocus
            class="w-full"
          />
        </UFormField>
        <UFormField
          :label="t('agenda.form.description')"
          :help="t('agenda.form.descriptionHelp')"
          name="description"
        >
          <UTextarea
            v-model="state.description"
            :rows="3"
            autoresize
            :maxrows="10"
            :maxlength="AGENDA_DESCRIPTION_MAX_LENGTH"
            class="w-full"
          />
        </UFormField>
        <UFormField name="acceptsSubmissions">
          <USwitch
            v-model="state.acceptsSubmissions"
            :label="t('agenda.acceptsSubmissions')"
            :description="t('agenda.acceptsSubmissionsHelp')"
          />
        </UFormField>
      </UForm>
    </template>
    <template #footer>
      <div class="flex w-full flex-wrap justify-end gap-2">
        <UButton
          color="neutral"
          variant="outline"
          :label="t('common.cancel')"
          :disabled="saving"
          @click="open = false"
        />
        <UButton
          type="submit"
          form="agenda-item-form"
          :label="editing ? t('common.save') : t('agenda.form.create')"
          :loading="saving"
          icon="i-lucide-check"
        />
      </div>
    </template>
  </UModal>
</template>
