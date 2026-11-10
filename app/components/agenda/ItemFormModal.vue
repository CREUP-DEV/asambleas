<script setup lang="ts">
import { z } from "zod/v4";
import type { FormSubmitEvent } from "@nuxt/ui";
import { DOCUMENT_KINDS, type DocumentKind } from "~~/shared/constants/domain";
import type { AgendaItemBody, AgendaItemDto } from "~~/shared/types/api";
import { normalizeSubmissionKinds } from "~~/shared/utils/agendaSubmissions";
import {
  AGENDA_DESCRIPTION_MAX_LENGTH,
  AGENDA_TITLE_MAX_LENGTH,
} from "~~/shared/utils/schemas/assembly";
import { containerKindGroups } from "~/composables/document/documentKinds";
import type { AgendaRootChangeRunner } from "~/utils/agendaTree";

/**
 * Creates or edits an agenda item. With `item` it edits it (PUT, with
 * optimistic locking); otherwise it creates one under `parent` (or as a root
 * item). Emits `saved` with the stored item, or `conflict` after a 409 so the
 * page refetches.
 *
 * "¿Los miembros presentan documentos aquí?" (No / Sí) says whether the item
 * takes documents from members, and each choice says what it does to the
 * agenda: with Sí every document added there gets a sub-item of its own;
 * with No the Secretaría adds one or several straight to the item. With Sí,
 * the kinds it takes are one select, the usual ones first; none chosen
 * means every kind. The form of an automatic sub-item says that its title
 * follows the document's until it is changed here.
 */
const props = withDefaults(
  defineProps<{
    apiBase: string;
    item?: AgendaItemDto | null;
    /** Parent of a new item, with its number, for the subtitle. */
    parent?: { id: string; title: string; number: string } | null;
    /**
     * Runs a save that may change the root items of a final agenda: the
     * page asks first when it has to and passes `confirmFinal`. Null when
     * the user says no. Without it the save is sent as is.
     */
    rootChange?: AgendaRootChangeRunner | null;
  }>(),
  { item: null, parent: null, rootChange: null },
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
    submissionKinds: z.array(z.enum(DOCUMENT_KINDS)),
  }),
);

type ItemForm = z.output<typeof schema.value>;

const state = reactive<ItemForm>({
  title: "",
  description: "",
  acceptsSubmissions: false,
  submissionKinds: [],
});
const saving = ref(false);
watch(
  open,
  (isOpen) => {
    if (!isOpen) return;
    state.title = props.item?.title ?? "";
    state.description = props.item?.description ?? "";
    state.acceptsSubmissions = props.item?.acceptsSubmissions ?? false;
    state.submissionKinds = [...(props.item?.submissionKinds ?? [])];
  },
  { immediate: true },
);

// Who presents here ------------------------------------------------------------

const YES = "yes";
const NO = "no";

const submissionChoice = computed({
  get: () => (state.acceptsSubmissions ? YES : NO),
  set: (value: string) => {
    state.acceptsSubmissions = value === YES;
  },
});
const submissionItems = computed(() => [
  {
    label: t("common.no"),
    description: t("agenda.container.noDescription"),
    value: NO,
  },
  {
    label: t("common.yes"),
    description: t("agenda.container.yesDescription"),
    value: YES,
  },
]);
const choiceCardsUi = { fieldset: "grid gap-2 sm:grid-cols-2" };

/** Every kind, the usual ones first. None chosen means all of them. */
const kindItems = computed(() => {
  const groups = containerKindGroups();
  return [...groups.common, ...groups.others].map((kind) => ({
    label: t(`agenda.documentKinds.${kind}`),
    value: kind,
  }));
});
/** Stored in the order of the catalogue, whatever the order of the clicks. */
const chosenKinds = computed<DocumentKind[]>({
  get: () => state.submissionKinds,
  set: (values) => {
    state.submissionKinds = DOCUMENT_KINDS.filter((kind) =>
      values.includes(kind),
    );
  },
});

/** An automatic sub-item: created for a document presented in its parent. */
const autoHint = computed(() => {
  if (!props.item?.auto) return undefined;
  return props.item.titleCustom
    ? t("agenda.container.autoCustomHint")
    : t("agenda.container.autoHint");
});

/**
 * The item carries a title this account may not read (`titleHidden`): the
 * server keeps its title and description whatever is sent, so both fields
 * are locked and say why.
 */
const titleLocked = computed(() => props.item?.titleHidden === true);
const titleHelp = computed(() =>
  titleLocked.value ? t("agenda.form.titleHiddenHelp") : autoHint.value,
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
    submissionKinds: normalizeSubmissionKinds(
      event.data.acceptsSubmissions,
      event.data.submissionKinds,
    ),
  };
  const item = props.item;
  // Root items change with a new root item or a new title of one.
  const changesRoots = item
    ? item.parentId === null && body.title !== item.title
    : !props.parent;
  const send = (confirmFinal: boolean) => {
    const confirmed = confirmFinal ? { confirmFinal: true } : {};
    return item
      ? api.send<AgendaItemDto>(`${props.apiBase}/agenda/${item.id}`, {
          method: "PUT",
          body: { ...body, updatedAt: item.updatedAt, ...confirmed },
        })
      : api.send<AgendaItemDto>(`${props.apiBase}/agenda`, {
          method: "POST",
          body: { ...body, parentId: props.parent?.id ?? null, ...confirmed },
        });
  };
  try {
    const saved = props.rootChange
      ? await props.rootChange(changesRoots, send)
      : await send(false);
    // The user chose not to change a final agenda: the form stays open.
    if (!saved) return;
    emit("saved", saved, !item);
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
        <UFormField
          :label="t('agenda.form.title')"
          :help="titleHelp"
          name="title"
          required
        >
          <UInput
            v-model="state.title"
            :maxlength="AGENDA_TITLE_MAX_LENGTH"
            :disabled="titleLocked"
            :autofocus="!titleLocked"
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
            :disabled="titleLocked"
            class="w-full"
          />
        </UFormField>
        <UFormField
          :label="t('agenda.container.question')"
          name="acceptsSubmissions"
        >
          <URadioGroup
            v-model="submissionChoice"
            :items="submissionItems"
            value-key="value"
            variant="card"
            :ui="choiceCardsUi"
            class="w-full"
            data-testid="agenda-container-choice"
          />
        </UFormField>
        <template v-if="state.acceptsSubmissions">
          <UFormField
            :label="t('agenda.container.kinds')"
            :help="t('agenda.container.kindsHelp')"
            name="submissionKinds"
          >
            <USelectMenu
              v-model="chosenKinds"
              :items="kindItems"
              value-key="value"
              multiple
              :search-input="false"
              :placeholder="t('agenda.container.allKinds')"
              class="w-full"
              data-testid="agenda-container-kinds"
            />
          </UFormField>
        </template>
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
