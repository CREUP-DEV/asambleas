<script setup lang="ts">
import { z } from "zod/v4";
import type { FormSubmitEvent } from "@nuxt/ui";
import {
  DOCUMENT_FORMATS,
  DOCUMENT_KIND_DEFAULTS,
  DOCUMENT_KINDS,
  MEMBER_KINDS,
  type DocumentFormat,
  type DocumentKind,
  type MemberKind,
} from "~~/shared/constants/domain";
import type {
  DocumentCreateBody,
  DocumentDto,
  MemberDto,
} from "~~/shared/types/api";
import { memberMayPresent } from "~~/shared/utils/presenterKinds";
import {
  documentPresenterMembers,
  formatMemberList,
} from "~/composables/document/documentPresenters";
import {
  proposeFromItem,
  type ItemProposal,
} from "~/composables/document/itemProposal";
import {
  ITEM_SELECT_UI,
  repropose,
} from "~/composables/document/itemProposalForm";

/**
 * "Añadir documento esperado": the Secretaría creates, in advance, an empty
 * document for the member that has to provide it (a CEA report, a
 * resolution), with an internal deadline. The member then finds it on their
 * home page and fills it in. Nothing opens afterwards: the panel shows it.
 *
 * The item is a numbered, searchable list whose long titles wrap. Choosing
 * it proposes the type and the title (proposeFromItem, as "Añadir
 * documento" does), over what the user has not changed. After a document is
 * added, the next opening keeps its item, type, format and deadline, and
 * asks again only who presents it and its title: a dozen CEA reports under
 * one item, all with the same deadline, take a presenter and a title each.
 *
 * The type's rules (amendments, vote) come from its defaults; only the
 * format is offered, as two cards in view (text on the platform or an
 * uploaded PDF).
 */
const props = defineProps<{
  /** "/api/assemblies/<id>" */
  apiBase: string;
  /**
   * Agenda items in agenda order, with their number ("2.1"; null for one
   * that is not in the agenda for everyone yet). `hasDocuments`: the item
   * already shows documents, so no title is proposed from it; left out, it
   * is taken as unknown and no title is proposed either (never a duplicate).
   */
  items: {
    id: string;
    number: string | null;
    title: string;
    hasDocuments?: boolean;
  }[];
}>();

const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{ created: [document: DocumentDto] }>();

const { t, locale } = useI18n();
const api = useApi();
const toast = useToast();
const now = useAppNow();

const TITLE_MAX = 300;
const formId = useId();

const schema = computed(() =>
  z.object({
    agendaItemId: z.string().min(1, t("tracking.expected.itemRequired")),
    kind: z.enum(DOCUMENT_KINDS, {
      error: () => t("tracking.expected.kindRequired"),
    }),
    title: z
      .string()
      .trim()
      .min(1, t("tracking.expected.titleRequired"))
      .max(TITLE_MAX, t("agenda.form.tooLong", { max: TITLE_MAX })),
    proponentMemberId: z
      .string()
      .min(1, t("tracking.expected.presenterRequired")),
    dueAt: z.string().nullable(),
    format: z.enum(DOCUMENT_FORMATS),
  }),
);

type ExpectedForm = z.output<typeof schema.value>;
type ExpectedFormState = Omit<ExpectedForm, "kind"> & {
  kind: DocumentKind | undefined;
};

function initialState(): ExpectedFormState {
  return {
    agendaItemId: "",
    kind: undefined,
    title: "",
    proponentMemberId: "",
    dueAt: null,
    format: "structured",
  };
}

const state = reactive<ExpectedFormState>(initialState());

/**
 * What the last document added leaves for the next one, in memory while the
 * page stays: its item, type, format and deadline.
 */
type KeptFields = Pick<
  ExpectedFormState,
  "agendaItemId" | "kind" | "format" | "dueAt"
>;
const kept = shallowRef<KeptFields | null>(null);

const NO_PROPOSAL: ItemProposal = { kind: null, title: null };
/** What was last proposed, to tell it from what the user typed or chose. */
const lastProposal = shallowRef<ItemProposal>(NO_PROPOSAL);

function proposalFor(itemId: string): ItemProposal {
  const item = props.items.find((candidate) => candidate.id === itemId);
  return item
    ? proposeFromItem({ ...item, hasDocuments: item.hasDocuments ?? true })
    : NO_PROPOSAL;
}

/** Another item: propose again the type and title the user has not changed. */
function onItem(itemId: string | undefined): void {
  const next = proposalFor(itemId ?? "");
  Object.assign(state, repropose(state, lastProposal.value, next), {
    agendaItemId: itemId ?? "",
  });
  lastProposal.value = next;
}

/** Lower bound of the picker: typed dates may still be earlier. */
const minDue = computed(() => new Date(now.value).toISOString());
const dueInPast = computed(
  () => state.dueAt !== null && new Date(state.dueAt).getTime() <= now.value,
);
const saving = ref(false);

// Members, loaded on first open.
const members = ref<MemberDto[]>([]);
const membersLoading = ref(false);
const membersFailed = ref(false);

async function loadMembers() {
  if (members.value.length > 0 || membersLoading.value) return;
  membersLoading.value = true;
  membersFailed.value = false;
  try {
    // Never the generic "CEA": it is not a member anyone presents for.
    members.value = addableMembers(await api.get<MemberDto[]>("/api/members"));
  } catch (error) {
    membersFailed.value = true;
    api.notifyError(error, "tracking.expected.membersError");
  } finally {
    membersLoading.value = false;
  }
}

watch(
  open,
  (isOpen) => {
    if (!isOpen) return;
    Object.assign(state, initialState(), kept.value ?? {});
    // The kept item may be gone from the agenda meanwhile.
    if (!props.items.some((item) => item.id === state.agendaItemId)) {
      state.agendaItemId = "";
    }
    // A kept type reads as proposed, so another item replaces it; the kept
    // item proposes no title again: a document was just added under it.
    lastProposal.value = kept.value
      ? { kind: kept.value.kind ?? null, title: null }
      : NO_PROPOSAL;
    void loadMembers();
  },
  { immediate: true },
);

const itemOptions = computed(() =>
  props.items.map((item) => ({
    label: numberedAgendaTitle(
      item.number,
      item.title,
      t("agenda.unlisted.inText"),
    ),
    value: item.id,
  })),
);

const kindOptions = computed(() =>
  DOCUMENT_KINDS.map((kind) => ({
    label: t(`agenda.documentKinds.${kind}`),
    value: kind,
  })),
);

/** Executive areas first: they provide most of the expected documents. */
const KIND_ORDER: readonly MemberKind[] = [
  "executive",
  ...MEMBER_KINDS.filter((kind) => kind !== "executive"),
];

interface MemberOption {
  label: string;
  description?: string;
  value: string;
  type?: "label";
}

/**
 * The member kinds that may present the document type chosen: a sectorial
 * never presents an internal motion (memberMayPresent).
 */
const presentingKinds = computed(() =>
  KIND_ORDER.filter(
    (kind) => !state.kind || memberMayPresent(state.kind, kind),
  ),
);

/** Grouped by kind; each group starts with its (unselectable) label. */
const memberOptions = computed<MemberOption[][]>(() =>
  presentingKinds.value
    .map((kind) => {
      const list: MemberOption[] = members.value
        .filter((candidate) => candidate.active && candidate.kind === kind)
        .map(memberMenuItem);
      if (list.length === 0) return [];
      const heading: MemberOption = {
        type: "label",
        label: t(`shell.memberKinds.${kind}`),
        value: `group:${kind}`,
      };
      return [heading, ...list];
    })
    .filter((group) => group.length > 0),
);

/**
 * Text or PDF, two cards (as in "Añadir documento"). A text says it can be
 * amended only when the type takes amendments.
 */
const formatOptions = computed(() =>
  DOCUMENT_FORMATS.map((format: DocumentFormat) => ({
    label: t(`agenda.newDocument.formatCards.${format}`),
    description:
      format === "structured" &&
      state.kind &&
      !DOCUMENT_KIND_DEFAULTS[state.kind].amendable
        ? t("agenda.newDocument.formatCards.structuredPlain")
        : t(`agenda.newDocument.formatCards.${format}Description`),
    value: format,
  })),
);
/** Side by side from `sm` up. */
const formatCardsUi = { fieldset: "grid gap-2 sm:grid-cols-2" };

async function onSubmit(event: FormSubmitEvent<ExpectedForm>) {
  const data = event.data;
  const body: DocumentCreateBody = {
    agendaItemId: data.agendaItemId,
    kind: data.kind,
    format: data.format,
    title: data.title,
    proponentMemberId: data.proponentMemberId,
    dueAt: data.dueAt,
    // A PDF takes no amendments, whatever the type's default.
    ...(data.format === "file" ? { amendable: false } : {}),
  };
  saving.value = true;
  try {
    const created = await api.send<DocumentDto>(`${props.apiBase}/documents`, {
      method: "POST",
      body,
    });
    emit("created", created);
    kept.value = {
      agendaItemId: data.agendaItemId,
      kind: data.kind,
      format: data.format,
      dueAt: data.dueAt,
    };
    open.value = false;
    // Every presenter, the main one first ("UPV, UV y UM").
    const presenters = documentPresenterMembers(created).map(
      (member) => member.acronym,
    );
    toast.add({
      title: t("tracking.expected.created"),
      description:
        presenters.length > 0
          ? t("tracking.expected.createdFor", {
              title: created.title,
              member: formatMemberList(presenters, locale.value),
            })
          : created.title,
      color: "success",
      icon: "i-lucide-file-plus",
    });
  } catch (error) {
    api.notifyError(error, "tracking.expected.error");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('tracking.expected.title')"
    :description="t('tracking.expected.description')"
    :dismissible="!saving"
    :ui="{ content: 'sm:max-w-xl' }"
  >
    <template #body>
      <UForm
        :id="formId"
        :schema="schema"
        :state="state"
        class="space-y-4"
        @submit="onSubmit"
      >
        <UFormField
          :label="t('tracking.expected.item')"
          name="agendaItemId"
          required
        >
          <USelectMenu
            :model-value="state.agendaItemId || undefined"
            :items="itemOptions"
            value-key="value"
            :placeholder="t('tracking.expected.itemPlaceholder')"
            :aria-label="
              selectMenuLabel(
                t('tracking.expected.item'),
                itemOptions,
                state.agendaItemId,
                t('tracking.expected.itemPlaceholder'),
              )
            "
            :search-input="labelledSearch(t('agenda.newDocument.searchItem'))"
            :ui="ITEM_SELECT_UI"
            class="w-full"
            @update:model-value="onItem"
          />
        </UFormField>

        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField :label="t('tracking.expected.kind')" name="kind" required>
            <USelectMenu
              v-model="state.kind"
              :items="kindOptions"
              value-key="value"
              :placeholder="t('tracking.expected.kindPlaceholder')"
              :search-input="labelledSearch(t('agenda.newDocument.searchKind'))"
              :aria-label="
                selectMenuLabel(
                  t('tracking.expected.kind'),
                  kindOptions,
                  state.kind,
                  t('tracking.expected.kindPlaceholder'),
                )
              "
              class="w-full"
            />
          </UFormField>
          <UFormField
            :label="t('tracking.expected.presenter')"
            :help="
              membersFailed ? t('tracking.expected.membersError') : undefined
            "
            name="proponentMemberId"
            required
          >
            <USelectMenu
              v-model="state.proponentMemberId"
              :items="memberOptions"
              value-key="value"
              :ui="MEMBER_MENU_UI"
              :filter-fields="MEMBER_MENU_FILTER_FIELDS"
              :loading="membersLoading"
              :placeholder="t('tracking.expected.presenterPlaceholder')"
              :search-input="
                labelledSearch(t('tracking.expected.searchMember'))
              "
              :aria-label="t('tracking.expected.presenter')"
              class="w-full"
            />
          </UFormField>
        </div>

        <UFormField
          :label="t('tracking.expected.documentTitle')"
          :help="t('tracking.expected.documentTitleHelp')"
          name="title"
          required
        >
          <UInput v-model="state.title" :maxlength="TITLE_MAX" class="w-full" />
        </UFormField>

        <UFormField
          :label="t('tracking.expected.deadline')"
          :help="t('tracking.expected.deadlineHelp')"
          name="dueAt"
        >
          <DocumentDateTimeInput
            v-model="state.dueAt"
            name="dueAt"
            :aria-label="t('tracking.expected.deadline')"
            :min="minDue"
          />
          <p
            v-if="dueInPast"
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
        </UFormField>

        <!-- Text or PDF, in view: it decides whether it can be amended -->
        <UFormField :label="t('tracking.expected.format')" name="format">
          <URadioGroup
            v-model="state.format"
            :items="formatOptions"
            value-key="value"
            variant="card"
            :ui="formatCardsUi"
            class="w-full"
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
          :form="formId"
          icon="i-lucide-file-plus"
          :label="t('tracking.expected.create')"
          :loading="saving"
        />
      </div>
    </template>
  </UModal>
</template>
