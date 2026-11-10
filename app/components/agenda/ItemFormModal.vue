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
 * takes documents from members. With Sí, the kinds it takes are chips in
 * view: "Todos los tipos" or the ones ticked, the usual ones first and the
 * rest behind "Más tipos". Each document presented there gets a sub-item of
 * its own, which the form says. The form of such an automatic sub-item says
 * that its title follows the document's until it is changed here.
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
/** The kinds beyond the usual ones are in view. */
const moreKindsOpen = ref(false);
/**
 * The kinds that show without unfolding beyond the usual ones: the ones
 * stored when the form opened, and the ones ticked since, added when the
 * list folds so a ticked kind never goes out of view.
 */
const storedKinds = shallowRef<DocumentKind[]>([]);

function toggleMoreKinds(): void {
  if (moreKindsOpen.value) {
    storedKinds.value = [
      ...new Set([...storedKinds.value, ...state.submissionKinds]),
    ];
  }
  moreKindsOpen.value = !moreKindsOpen.value;
}

watch(
  open,
  (isOpen) => {
    if (!isOpen) return;
    state.title = props.item?.title ?? "";
    state.description = props.item?.description ?? "";
    state.acceptsSubmissions = props.item?.acceptsSubmissions ?? false;
    storedKinds.value = [...(props.item?.submissionKinds ?? [])];
    state.submissionKinds = [...storedKinds.value];
    moreKindsOpen.value = false;
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

/** Stands for "every kind" among the chips: no kind is stored then. */
const ALL_KINDS = "__all__";
type KindChip = DocumentKind | typeof ALL_KINDS;

const kindGroups = computed(() => containerKindGroups(storedKinds.value));

const kindChips = computed<{ label: string; value: KindChip }[]>(() => [
  { label: t("agenda.container.allKinds"), value: ALL_KINDS },
  ...[
    ...kindGroups.value.common,
    ...(moreKindsOpen.value ? kindGroups.value.others : []),
  ].map((kind) => ({
    label: t(`agenda.documentKinds.${kind}`),
    value: kind,
  })),
]);

/** "Todos los tipos" is ticked while no kind is. */
const chosenChips = computed<KindChip[]>(() =>
  state.submissionKinds.length === 0 ? [ALL_KINDS] : state.submissionKinds,
);

/**
 * Ticking "Todos los tipos" clears the kinds, ticking a kind unticks it,
 * and unticking the last kind goes back to all.
 */
function onKindChips(values: KindChip[]): void {
  const pickedAll =
    values.includes(ALL_KINDS) && state.submissionKinds.length > 0;
  state.submissionKinds = pickedAll
    ? []
    : DOCUMENT_KINDS.filter((kind) => values.includes(kind));
}
const kindChipsUi = { fieldset: "flex flex-wrap gap-2" };

/** An automatic sub-item: created for a document presented in its parent. */
const autoHint = computed(() => {
  if (!props.item?.auto) return undefined;
  return props.item.titleCustom
    ? t("agenda.container.autoCustomHint")
    : t("agenda.container.autoHint");
});

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
          :help="autoHint"
          name="title"
          required
        >
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
            name="submissionKinds"
          >
            <UCheckboxGroup
              :model-value="chosenChips"
              :items="kindChips"
              value-key="value"
              variant="card"
              size="sm"
              orientation="horizontal"
              :ui="kindChipsUi"
              class="w-full"
              data-testid="agenda-container-kinds"
              @update:model-value="onKindChips($event as KindChip[])"
            />
            <UButton
              v-if="kindGroups.others.length > 0"
              color="neutral"
              variant="link"
              size="sm"
              class="mt-2 px-0"
              :icon="
                moreKindsOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'
              "
              :label="
                moreKindsOpen
                  ? t('agenda.container.fewerKinds')
                  : t('agenda.container.moreKinds')
              "
              :aria-expanded="moreKindsOpen"
              @click="toggleMoreKinds"
            />
          </UFormField>
          <p class="text-muted flex items-start gap-2 text-sm">
            <UIcon
              name="i-lucide-list-tree"
              class="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            <span>{{ t("agenda.container.ownItem") }}</span>
          </p>
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
