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
 *
 * "Se vota el punto" marks an item voted by itself (a ratification, an
 * election), which the control sheet reads «Pendiente» until its vote. It
 * is not offered while the item takes documents from members, and the save
 * sends it off then, so a container never keeps one nobody sees. When the
 * item already has voted documents (`votedThroughDocuments`) a quiet line
 * says it is voted through them; the switch stays, since the server ignores
 * it while those documents are voted and keeps it for when they are not.
 */
const props = withDefaults(
  defineProps<{
    apiBase: string;
    item?: AgendaItemDto | null;
    /**
     * Parent of a new item, with its number, for the subtitle; null for a
     * parent without one (not in the agenda for everyone yet).
     */
    parent?: { id: string; title: string; number: string | null } | null;
    /**
     * Runs a save that may change the root items of a final agenda: the
     * page asks first when it has to and passes `confirmFinal`. Null when
     * the user says no. Without it the save is sent as is.
     */
    rootChange?: AgendaRootChangeRunner | null;
    /**
     * The item being edited has voted documents (itemHasVotedDocuments):
     * those votes are the item's, so "Se vota el punto" says so.
     */
    votedThroughDocuments?: boolean;
  }>(),
  {
    item: null,
    parent: null,
    rootChange: null,
    votedThroughDocuments: false,
  },
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
    voted: z.boolean(),
  }),
);

type ItemForm = z.output<typeof schema.value>;

const state = reactive<ItemForm>({
  title: "",
  description: "",
  acceptsSubmissions: false,
  submissionKinds: [],
  voted: false,
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
    state.voted = props.item?.voted ?? false;
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
        number: agendaNumberInText(
          props.parent.number,
          t("agenda.unlisted.inText"),
        ),
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
    // Not offered for a container: sent off so none keeps it unseen.
    voted: !event.data.acceptsSubmissions && event.data.voted,
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
              :aria-label="
                selectMenuLabel(
                  t('agenda.container.kinds'),
                  kindItems,
                  chosenKinds,
                  t('agenda.container.allKinds'),
                )
              "
              class="w-full"
              data-testid="agenda-container-kinds"
            />
          </UFormField>
        </template>
        <UFormField v-else name="voted">
          <USwitch
            v-model="state.voted"
            :label="t('agenda.itemVote.label')"
            :description="
              votedThroughDocuments ? undefined : t('agenda.itemVote.help')
            "
            data-testid="agenda-voted-switch"
          />
          <p
            v-if="votedThroughDocuments"
            class="text-muted mt-2 flex items-start gap-1.5 text-sm"
            data-testid="agenda-voted-through-documents"
          >
            <UIcon
              name="i-lucide-info"
              class="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            <span>{{ t("agenda.itemVote.throughDocuments") }}</span>
          </p>
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
