<script setup lang="ts">
import { z } from "zod/v4";
import type { FormError, FormSubmitEvent } from "@nuxt/ui";
import {
  ACCEPTED_AMENDMENT_RULES,
  DOCUMENT_FORMATS,
  DOCUMENT_KINDS,
  DOCUMENT_KIND_DEFAULTS,
  MAJORITIES,
  type DocumentFormat,
  type DocumentKind,
  type Majority,
} from "~~/shared/constants/domain";
import type {
  DocumentCreateBody,
  DocumentDto,
  MemberDto,
} from "~~/shared/types/api";
import { SUBMISSION_KIND_REFUSED_REASON } from "~~/shared/utils/agendaSubmissions";
import { mayUseFileFormat } from "~~/shared/utils/documentFormat";
import { orderMembers } from "~~/shared/utils/memberOrder";
import { memberMayPresent } from "~~/shared/utils/presenterKinds";
import {
  memberSubmissionKinds,
  presenterKindGroups,
} from "~/composables/document/documentKinds";
import {
  choicePresenterIds,
  coPresentersDroppedWithoutLead,
  documentPresenterMembers,
  formatMemberList,
  formPresenterChoice,
  isDocumentPresenter,
  mainPresenterMissing,
  presenterFields,
  withDefaultMainPresenter,
  withMainAsLead,
  withPresenterLead,
  type PresenterChoice,
} from "~/composables/document/documentPresenters";
import {
  editorFrom,
  type AddOrigin,
} from "~/composables/document/agendaReturn";
import {
  proposeFromItem,
  type ItemProposal,
} from "~/composables/document/itemProposal";

/**
 * Adds a document under an agenda item.
 *
 * - The item is the first field, a numbered and searchable list (members
 *   only get the items that take their documents). It starts on `itemId`
 *   ("Añadir documento" on an item) and stays changeable, so the buttons at
 *   the top of the home page and of the agenda open the same modal with no
 *   item yet.
 * - Under an item where members present documents, the document gets a
 *   sub-item of its own (the server creates it), which the form says. Such
 *   an item may name the kinds it takes: members are offered only those
 *   (one kind alone comes chosen). Automatic sub-items are never offered.
 * - The type and the title are proposed from the item (proposeFromItem):
 *   "Aprobación, si procede, del Posicionamiento sobre X" gives a
 *   positioning titled "Posicionamiento sobre X". Choosing another item
 *   proposes again what the user has not changed.
 * - Members ("Presentar documento") go through the first step of a short
 *   guided flow: what it is (type, title, short summary) and, for types that
 *   take no amendments, whether the text comes as a PDF (a type that takes
 *   amendments is always text, which the server enforces too). The types
 *   their member usually presents are cards (a CEA area's reports and plans,
 *   a council's positionings and resolutions), with a last card "Otro tipo"
 *   for the rest (DocumentKindPicker). The draft is created and the editor
 *   opens on step 2 (the text) and step 3 (send it to the Secretaría).
 * - Managers choose the type from a searchable menu, and whether it is text
 *   on the platform or an uploaded PDF from two cards in view. They also
 *   choose who presents it and the internal deadline, so the Secretaría can
 *   create in advance the documents it expects. The rules of the type
 *   (amendments, vote, majority) show as one line with "Cambiar"; the
 *   controls stay under "Más opciones", with the type's defaults
 *   preselected.
 *   A document expected from a member stays on the agenda ("Crear"), unless
 *   the Secretaría already has its text ("Crear y subir el texto"); one with
 *   no presenter, or presented by the manager's own member, opens the
 *   editor. The editor knows where it was opened from (`origin`) and comes
 *   back there when the document is published, or with this modal open on
 *   the next item ("Publicar y añadir otro", "Guardar y añadir otro").
 * - Both may add co-presenters ("¿Lo presentáis varios miembros?", folded);
 *   with several presenters, who answers the amendments is a required
 *   choice, which starts on the member presenting it (or the manager's
 *   "Quién lo presenta"). A member always stays among the presenters of
 *   what it presents. For managers "Quién lo presenta" is the main
 *   presenter: choosing another one to answer swaps it in. Choosing nobody
 *   there leaves no co-presenters, and the field names the ones removed.
 *
 * Emits `created` with the new document.
 */
const props = defineProps<{
  apiBase: string;
  /** Localized hub path ("/asambleas/80-ago"). */
  basePath: string;
  /**
   * Agenda items in agenda order with their number ("3.2"). `hasDocuments`:
   * the item already shows documents, so no title is proposed from it.
   * `submissionKinds`: the kinds it takes from members (none: every kind).
   * `auto`: the sub-item of one document, never offered.
   */
  items: {
    id: string;
    title: string;
    number: string;
    acceptsSubmissions: boolean;
    submissionKinds?: DocumentKind[];
    auto?: boolean;
    hasDocuments: boolean;
  }[];
  /** The item to start on, if any. */
  itemId: string | null;
  mode: "manager" | "member";
  /** Where the editor comes back to (the agenda or the home page). */
  origin: AddOrigin;
}>();

const open = defineModel<boolean>("open", { default: false });

const emit = defineEmits<{ created: [document: DocumentDto] }>();

const { t, locale } = useI18n();
const api = useApi();
const toast = useToast();
const { member } = useMe();

const TITLE_MAX = 300;
const SUMMARY_MAX = 5_000;
/** Sentinel for "no proponent" in the member select. */
const NO_PROPONENT = "__none__";

const isManager = computed(() => props.mode === "manager");

const schema = computed(() =>
  z.object({
    agendaItemId: z.string().min(1, t("agenda.newDocument.itemRequired")),
    kind: z.enum(DOCUMENT_KINDS, {
      error: () => t("agenda.newDocument.kindRequired"),
    }),
    format: z.enum(DOCUMENT_FORMATS),
    title: z
      .string()
      .trim()
      .min(1, t("agenda.newDocument.titleRequired"))
      .max(TITLE_MAX, t("agenda.form.tooLong", { max: TITLE_MAX })),
    summary: z
      .string()
      .max(SUMMARY_MAX, t("agenda.form.tooLong", { max: SUMMARY_MAX })),
    proponent: z.string(),
    coProponents: z.array(z.string()),
    mainPresenter: z.string().nullable(),
    dueAt: z.string().nullable(),
    amendable: z.boolean(),
    acceptedAmendments: z.enum(ACCEPTED_AMENDMENT_RULES),
    voted: z.boolean(),
    majority: z.enum(MAJORITIES),
  }),
);

/**
 * Several presenters need the one that answers the amendments. Checked
 * beside the schema (not as a refinement, which Zod skips while another
 * field is invalid), so every error shows on the first try.
 */
function validatePresenters(current: Partial<DocumentFormState>): FormError[] {
  const missing = mainPresenterMissing(
    choiceOf({
      proponent: current.proponent ?? NO_PROPONENT,
      coProponents: current.coProponents ?? [],
      mainPresenter: current.mainPresenter ?? null,
    }),
  );
  return missing
    ? [
        {
          name: "mainPresenter",
          message: t("document.presenters.mainRequired"),
        },
      ]
    : [];
}

type DocumentForm = z.output<typeof schema.value>;
/** The kind starts empty: the user picks it. */
type DocumentFormState = Omit<DocumentForm, "kind"> & {
  kind: DocumentKind | undefined;
};

type AgendaItemOption = (typeof props.items)[number];

/** The kinds the user's member may present under an item (members). */
function kindsTakenBy(item: AgendaItemOption): DocumentKind[] {
  return memberSubmissionKinds(
    {
      acceptsSubmissions: item.acceptsSubmissions,
      submissionKinds: item.submissionKinds ?? [],
    },
    member.value?.kind,
  );
}

/**
 * The items the user may present under: managers anywhere but the automatic
 * sub-item of another document, members where the item takes a kind their
 * member may present.
 */
const pickableItems = computed(() =>
  props.items.filter((item) =>
    isManager.value ? !item.auto : kindsTakenBy(item).length > 0,
  ),
);

/**
 * Type and title proposed from an item (none without an item). A presenter
 * is never proposed a type its member may not present (a sectorial under the
 * internal motions' item) or the item does not take: the type stays empty
 * for them to choose.
 */
function proposalFor(itemId: string): ItemProposal {
  const item = props.items.find((candidate) => candidate.id === itemId);
  if (!item) return { kind: null, title: null };
  const proposal = proposeFromItem(item);
  if (isManager.value) return proposal;
  // Members: only a kind the item takes from their member, and the only
  // one when there is no other.
  const taken = kindsTakenBy(item);
  const [only] = taken;
  if (taken.length === 1 && only) return { ...proposal, kind: only };
  return proposal.kind && !taken.includes(proposal.kind)
    ? { ...proposal, kind: null }
    : proposal;
}

function startItemId(): string {
  const wanted = props.itemId;
  return wanted && pickableItems.value.some((item) => item.id === wanted)
    ? wanted
    : "";
}

function initialState(): DocumentFormState {
  const agendaItemId = startItemId();
  const proposal = proposalFor(agendaItemId);
  return {
    agendaItemId,
    kind: proposal.kind ?? undefined,
    format: "structured",
    title: proposal.title ?? "",
    summary: "",
    proponent: member.value?.id ?? NO_PROPONENT,
    coProponents: [],
    mainPresenter: null,
    dueAt: null,
    amendable: true,
    acceptedAmendments: "vote",
    voted: true,
    majority: "simple",
  };
}

/**
 * The presenters as chosen: the manager's pick (or the member's own member,
 * which a member cannot remove), the co-presenters and the main one.
 */
function choiceOf(data: {
  proponent: string;
  coProponents: string[];
  mainPresenter: string | null;
}): PresenterChoice {
  const leadId = isManager.value
    ? data.proponent === NO_PROPONENT
      ? null
      : data.proponent
    : (member.value?.id ?? null);
  // Nobody presents it (the Secretaría prepares it): no co-presenters either.
  return formPresenterChoice({
    leadId,
    coIds: data.coProponents,
    mainId: data.mainPresenter,
  });
}

const state = reactive<DocumentFormState>(initialState());
/** What was last proposed, to tell it from what the user typed or chose. */
const lastProposal = shallowRef<ItemProposal>(proposalFor(state.agendaItemId));

// Another item: propose again the type and title the user has not changed.
watch(
  () => state.agendaItemId,
  (itemId) => {
    const previous = lastProposal.value;
    const next = proposalFor(itemId);
    if (state.kind === (previous.kind ?? undefined)) {
      state.kind = next.kind ?? undefined;
    }
    if (state.title === (previous.title ?? "")) state.title = next.title ?? "";
    lastProposal.value = next;
    // Members: a type the new item does not take is not kept.
    if (!isManager.value && state.kind) {
      const item = selectedItem.value;
      if (item && !kindsTakenBy(item).includes(state.kind)) {
        state.kind = next.kind ?? undefined;
      }
    }
  },
);

/** The item chosen, if any. */
const selectedItem = computed(
  () => props.items.find((item) => item.id === state.agendaItemId) ?? null,
);

/** Numbered, searchable items; long titles wrap. */
const itemOptions = computed(() =>
  pickableItems.value.map((item) => ({
    label: `${item.number}. ${item.title}`,
    value: item.id,
  })),
);
const itemSelectUi = {
  value: "whitespace-normal text-start",
  itemLabel: "whitespace-normal",
};
const saving = ref(false);
const advancedOpen = ref(false);
const advancedTriggerId = useId();

/**
 * "Cambiar" in the rules summary opens the controls and leaves the dialog as
 * it does: focus goes to the trigger of the section it opened.
 */
async function openAdvanced(): Promise<void> {
  advancedOpen.value = true;
  await nextTick();
  document.getElementById(advancedTriggerId)?.focus();
}

// Members for the proponent select (managers, on open) and the co-presenters
// (members, when they unfold that section).
const members = ref<MemberDto[]>([]);
const membersLoading = ref(false);
const membersFailed = ref(false);

async function loadMembers() {
  if (members.value.length > 0 || membersLoading.value) return;
  membersLoading.value = true;
  membersFailed.value = false;
  try {
    members.value = await api.get<MemberDto[]>("/api/members");
  } catch (error) {
    membersFailed.value = true;
    api.notifyError(error, "agenda.newDocument.membersError");
  } finally {
    membersLoading.value = false;
  }
}

watch(
  open,
  (isOpen) => {
    if (!isOpen) return;
    Object.assign(state, initialState());
    lastProposal.value = proposalFor(state.agendaItemId);
    advancedOpen.value = false;
    if (isManager.value) void loadMembers();
  },
  { immediate: true },
);

/** The type's own rules: amendments, accepted amendments, vote, majority. */
const kindDefaults = computed(() =>
  state.kind ? DOCUMENT_KIND_DEFAULTS[state.kind] : null,
);

/**
 * Members are offered a PDF only for types that take no amendments (the
 * server refuses it otherwise); with no type yet, no choice either.
 */
const pdfAllowed = computed(() =>
  state.kind ? mayUseFileFormat(state.kind, isManager.value) : isManager.value,
);

// A new kind resets the rules to its defaults (and a PDF it cannot take).
watch(
  () => state.kind,
  () => {
    const defaults = kindDefaults.value;
    if (!defaults) return;
    if (!pdfAllowed.value) state.format = "structured";
    state.amendable = state.format === "file" ? false : defaults.amendable;
    state.acceptedAmendments = defaults.acceptedAmendments;
    state.voted = defaults.voted;
    state.majority = defaults.majority;
  },
);
watch(
  () => state.format,
  (format) => {
    state.amendable =
      format === "file" ? false : (kindDefaults.value?.amendable ?? true);
  },
);

/** The first presenter: the manager's pick, or the member's own member. */
const leadId = computed(() => choiceOf(state).leadId);

// Another "Quién lo presenta" leaves the co-presenters (and takes the
// answer to the amendments if the previous one had it).
watch(
  () => state.proponent,
  (next, previous) => {
    if (!isManager.value) return;
    const lead = next === NO_PROPONENT ? null : next;
    const before = previous === NO_PROPONENT ? null : (previous ?? null);
    const updated = withPresenterLead(
      {
        leadId: before,
        coIds: state.coProponents,
        mainId: state.mainPresenter,
      },
      lead,
    );
    state.coProponents = [...updated.coIds];
    state.mainPresenter = updated.mainId;
  },
);

// Several presenters and none of them answering: the member presenting it
// (or the manager's pick) answers until another one is chosen.
watch(
  () => choicePresenterIds(choiceOf(state)).join(),
  () => {
    const next = withDefaultMainPresenter(choiceOf(state));
    if (next.mainId !== state.mainPresenter) state.mainPresenter = next.mainId;
  },
);

/**
 * Who answers the amendments was chosen. Managers: the chosen presenter
 * becomes "Quién lo presenta" and the previous one a co-presenter (the
 * watcher on the lead then keeps both).
 */
function onMainPick(id: string | null): void {
  if (!isManager.value) {
    state.mainPresenter = id;
    return;
  }
  const next = withMainAsLead(choiceOf(state), id);
  state.coProponents = [...next.coIds];
  state.mainPresenter = next.mainId;
  state.proponent = next.leadId ?? NO_PROPONENT;
}

/** Members to name in the presenters' choice even before the list loads. */
const knownMembers = computed(() => (member.value ? [member.value] : []));

/** Managers: every type, in a searchable menu. */
const kindItems = computed(() =>
  DOCUMENT_KINDS.map((kind: DocumentKind) => ({
    label: t(`agenda.documentKinds.${kind}`),
    value: kind,
  })),
);
/** Members: the types their member usually presents, as cards. */
const memberKindGroups = computed(() =>
  presenterKindGroups({
    memberKind: member.value?.kind,
    accepted: selectedItem.value?.acceptsSubmissions
      ? selectedItem.value.submissionKinds
      : null,
  }),
);
/**
 * Managers: text or PDF, two cards. A text says it can be amended only when
 * the type takes amendments.
 */
const formatItems = computed(() =>
  DOCUMENT_FORMATS.map((format: DocumentFormat) => ({
    label: t(`agenda.newDocument.formatCards.${format}`),
    description:
      format === "structured" && kindDefaults.value?.amendable === false
        ? t("agenda.newDocument.formatCards.structuredPlain")
        : t(`agenda.newDocument.formatCards.${format}Description`),
    value: format,
  })),
);
/** The presenter's choice, in their words. */
const sourceItems = computed(() =>
  DOCUMENT_FORMATS.map((format: DocumentFormat) => ({
    label: t(`agenda.newDocument.source.${format}`),
    description: t(`agenda.newDocument.source.${format}Description`),
    value: format,
  })),
);
const majorityItems = computed(() =>
  MAJORITIES.map((majority: Majority) => ({
    label: t(`agenda.majorities.${majority}`),
    value: majority,
  })),
);
/** Cards side by side, wrapping where they do not fit. */
const formatCardsUi = { fieldset: "grid gap-2 sm:grid-cols-2" };
const majorityCardsUi = { fieldset: "flex-wrap gap-2" };
/**
 * The members that may present a document of the kind chosen: a sectorial
 * is not offered for an internal motion (memberMayPresent), and the generic
 * "CEA" never is (it is not a member). The account's own kind goes first
 * (orderMembers), then the general order.
 */
const presentableMembers = computed<MemberDto[]>(() =>
  orderMembers(
    addableMembers(members.value).filter(
      (candidate) =>
        !state.kind || memberMayPresent(state.kind, candidate.kind),
    ),
    member.value?.kind ?? null,
  ),
);

const memberItems = computed(() => [
  { label: t("agenda.newDocument.noProponent"), value: NO_PROPONENT },
  ...presentableMembers.value
    .filter((candidate) => candidate.active || candidate.id === state.proponent)
    .map((candidate) => ({
      label: memberLabel(candidate),
      value: candidate.id,
    })),
]);

/** The presenter's three steps; this modal is the first one. */
const steps = computed(() => [
  t("agenda.newDocument.steps.what"),
  t("agenda.newDocument.steps.text"),
  t("agenda.newDocument.steps.send"),
]);

/**
 * The acronyms of who will present it (the manager's pick first), for the
 * deadline help: "Hasta cuándo tienen CEUM y UPV para enviarlo".
 */
const presenterAcronyms = computed(() =>
  choicePresenterIds(choiceOf(state))
    .map(
      (id) =>
        members.value.find((candidate) => candidate.id === id)?.acronym ?? null,
    )
    .filter((acronym): acronym is string => acronym !== null),
);

/**
 * Managers: "Sin proponente" leaves out the co-presenters already chosen;
 * the field names them (they come back if someone presents it again).
 */
const proponentHelp = computed(() => {
  if (membersFailed.value) return t("agenda.newDocument.membersError");
  if (!isManager.value || state.proponent !== NO_PROPONENT) return undefined;
  const dropped = coPresentersDroppedWithoutLead({
    leadId: null,
    coIds: state.coProponents,
    mainId: state.mainPresenter,
  });
  if (dropped.length === 0) return undefined;
  const acronyms = dropped.map(
    (id) =>
      members.value.find((candidate) => candidate.id === id)?.acronym ?? id,
  );
  return t(
    "document.presenters.droppedWithoutLead",
    { members: formatMemberList(acronyms, locale.value) },
    acronyms.length,
  );
});

/**
 * Managers: the text will come from another member (the editor opens only
 * on "Crear y subir el texto").
 */
const expectsOtherMember = computed(
  () =>
    isManager.value &&
    state.proponent !== NO_PROPONENT &&
    state.proponent !== member.value?.id,
);
/** "Crear y subir el texto" was pressed. */
const uploadNow = ref(false);

/** Managers stay on the agenda when someone else has to provide the text. */
function opensEditor(created: DocumentDto): boolean {
  if (!isManager.value || uploadNow.value) return true;
  return (
    created.proponent === null || isDocumentPresenter(created, member.value?.id)
  );
}

/** The server refused the type: the item does not take it (422). */
function refusedKind(error: unknown): boolean {
  const body = (error as { data?: { data?: { reason?: unknown } } } | null)
    ?.data;
  return body?.data?.reason === SUBMISSION_KIND_REFUSED_REASON;
}

async function onSubmit(event: FormSubmitEvent<DocumentForm>) {
  const data = event.data;
  const presenters = presenterFields(choiceOf(data));
  const amendable = data.format === "file" ? false : data.amendable;
  // A member presenting alone sends no presenter: the server uses its own.
  const jointly = presenters.coProponentMemberIds.length > 0;
  const body: DocumentCreateBody = {
    agendaItemId: data.agendaItemId,
    kind: data.kind,
    format: data.format,
    title: data.title,
    summary: data.summary.trim() || null,
    ...(jointly ? presenters : {}),
    ...(isManager.value
      ? {
          proponentMemberId: presenters.proponentMemberId,
          amendable,
          ...(amendable ? { acceptedAmendments: data.acceptedAmendments } : {}),
          voted: data.voted,
          majority: data.majority,
          dueAt: data.dueAt,
        }
      : {}),
  };
  saving.value = true;
  try {
    const created = await api.send<DocumentDto>(`${props.apiBase}/documents`, {
      method: "POST",
      body,
    });
    emit("created", created);
    open.value = false;
    const editorPath = editorFrom(
      `${props.basePath}/documentos/${encodeURIComponent(created.slug)}`,
      props.origin,
    );
    if (opensEditor(created)) {
      toast.add({
        title: isManager.value
          ? t("agenda.newDocument.created")
          : t("agenda.newDocument.draftCreated"),
        description: isManager.value
          ? created.title
          : t("agenda.newDocument.draftCreatedDescription"),
        color: "success",
        icon: "i-lucide-file-plus",
      });
      await navigateTo(editorPath);
      return;
    }
    const expectedFrom = documentPresenterMembers(created).map(
      (presenter) => presenter.acronym,
    );
    toast.add({
      title: t("agenda.newDocument.created"),
      description:
        expectedFrom.length > 0
          ? t(
              "agenda.newDocument.expectedFrom",
              { member: formatMemberList(expectedFrom, locale.value) },
              expectedFrom.length,
            )
          : created.title,
      color: "success",
      icon: "i-lucide-file-plus",
      actions: [
        {
          label: t("agenda.newDocument.openDocument"),
          color: "neutral",
          variant: "outline",
          onClick: () => {
            void navigateTo(editorPath);
          },
        },
      ],
    });
  } catch (error) {
    if (refusedKind(error)) {
      toast.add({
        title: t("agenda.newDocument.error"),
        description: t("agenda.container.kindRefused"),
        color: "error",
        icon: "i-lucide-circle-alert",
      });
    } else {
      api.notifyError(error, "agenda.newDocument.error");
    }
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="
      isManager
        ? t('agenda.newDocument.title')
        : t('agenda.newDocument.submitTitle')
    "
    :dismissible="!saving"
    :ui="{ content: 'sm:max-w-2xl' }"
  >
    <template #body>
      <!-- The presenter's guided flow: this is step 1 of 3 -->
      <ol
        v-if="!isManager"
        class="mb-5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
        :aria-label="t('agenda.newDocument.steps.label')"
      >
        <li
          v-for="(step, index) in steps"
          :key="step"
          class="flex items-center gap-2"
          :aria-current="index === 0 ? 'step' : undefined"
        >
          <span
            class="inline-flex size-6 items-center justify-center rounded-full text-xs font-semibold tabular-nums"
            :class="
              index === 0
                ? 'bg-primary text-inverted'
                : 'bg-elevated text-muted'
            "
            aria-hidden="true"
          >
            {{ index + 1 }}
          </span>
          <span
            :class="index === 0 ? 'text-highlighted font-medium' : 'text-muted'"
          >
            <span class="sr-only">
              {{
                t("agenda.newDocument.steps.position", {
                  step: index + 1,
                  total: steps.length,
                })
              }}
            </span>
            {{ step }}
          </span>
          <UIcon
            v-if="index < steps.length - 1"
            name="i-lucide-chevron-right"
            class="text-dimmed size-4"
            aria-hidden="true"
          />
        </li>
      </ol>

      <UForm
        id="agenda-new-document-form"
        :schema="schema"
        :validate="validatePresenters"
        :state="state"
        class="space-y-4"
        @submit="onSubmit"
      >
        <UFormField
          :label="t('agenda.newDocument.item')"
          :help="
            selectedItem?.acceptsSubmissions
              ? t('agenda.container.newDocumentHint')
              : undefined
          "
          name="agendaItemId"
          required
        >
          <USelectMenu
            v-model="state.agendaItemId"
            :items="itemOptions"
            value-key="value"
            :placeholder="t('agenda.newDocument.itemPlaceholder')"
            :aria-label="
              selectMenuLabel(
                t('agenda.newDocument.item'),
                itemOptions,
                state.agendaItemId,
                t('agenda.newDocument.itemPlaceholder'),
              )
            "
            :search-input="labelledSearch(t('agenda.newDocument.searchItem'))"
            :ui="itemSelectUi"
            class="w-full"
          />
        </UFormField>

        <UFormField :label="t('agenda.newDocument.kind')" name="kind" required>
          <DocumentKindPicker
            v-if="!isManager"
            v-model="state.kind"
            :groups="memberKindGroups"
            labels="agenda.documentKinds"
            :disabled="saving"
          />
          <USelectMenu
            v-else
            v-model="state.kind"
            :items="kindItems"
            value-key="value"
            :placeholder="t('agenda.newDocument.kindPlaceholder')"
            :aria-label="
              selectMenuLabel(
                t('agenda.newDocument.kind'),
                kindItems,
                state.kind,
                t('agenda.newDocument.kindPlaceholder'),
              )
            "
            :search-input="labelledSearch(t('agenda.newDocument.searchKind'))"
            class="w-full sm:w-80"
          />
        </UFormField>

        <UFormField
          :label="t('agenda.newDocument.documentTitle')"
          :help="
            lastProposal.title && state.title === lastProposal.title
              ? t('agenda.newDocument.titleFromItem')
              : undefined
          "
          name="title"
          required
        >
          <UInput v-model="state.title" :maxlength="TITLE_MAX" class="w-full" />
        </UFormField>

        <UFormField
          :label="t('agenda.newDocument.summary')"
          :help="t('agenda.newDocument.summaryHelp')"
          name="summary"
        >
          <UTextarea
            v-model="state.summary"
            :rows="2"
            autoresize
            :maxrows="8"
            :maxlength="SUMMARY_MAX"
            class="w-full"
          />
        </UFormField>

        <!-- Members: how the text will come, only when a PDF is possible -->
        <template v-if="!isManager">
          <UFormField
            v-if="pdfAllowed"
            :label="t('agenda.newDocument.source.label')"
            name="format"
          >
            <URadioGroup
              v-model="state.format"
              :items="sourceItems"
              value-key="value"
              orientation="vertical"
              variant="card"
              class="w-full"
            />
          </UFormField>
          <p
            v-else-if="state.kind"
            class="text-muted flex items-start gap-2 text-sm"
          >
            <UIcon
              name="i-lucide-file-text"
              class="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            {{ t("agenda.newDocument.source.wordHint") }}
          </p>

          <p v-if="member" class="text-muted flex items-center gap-2 text-sm">
            {{ t("agenda.newDocument.presentingAs") }}
            <CommonMemberBadge :member="member" show-name />
          </p>
          <DocumentPresentersField
            v-if="member"
            v-model:co-ids="state.coProponents"
            :main-id="state.mainPresenter"
            voice="presenter"
            :lead-id="leadId"
            :members="presentableMembers"
            :known="knownMembers"
            :loading="membersLoading"
            :own-member-id="member.id"
            :disabled="saving"
            @update:main-id="onMainPick"
            @load="loadMembers"
          />
        </template>

        <!-- Managers: text or PDF, in view -->
        <UFormField
          v-if="isManager"
          :label="t('agenda.newDocument.format')"
          name="format"
        >
          <URadioGroup
            v-model="state.format"
            :items="formatItems"
            value-key="value"
            variant="card"
            :ui="formatCardsUi"
            class="w-full"
          />
        </UFormField>

        <!-- Managers: who presents it and by when -->
        <div v-if="isManager" class="grid gap-4 sm:grid-cols-2">
          <UFormField
            :label="t('agenda.newDocument.proponent')"
            name="proponent"
            :help="proponentHelp"
          >
            <USelectMenu
              v-model="state.proponent"
              :items="memberItems"
              value-key="value"
              :loading="membersLoading"
              :aria-label="
                selectMenuLabel(
                  t('agenda.newDocument.proponent'),
                  memberItems,
                  state.proponent,
                )
              "
              :search-input="
                labelledSearch(t('agenda.newDocument.searchMember'))
              "
              class="w-full"
            />
          </UFormField>
          <UFormField
            :label="t('agenda.newDocument.dueAt')"
            :hint="t('agenda.newDocument.optional')"
            :help="
              presenterAcronyms.length > 0
                ? t(
                    'agenda.newDocument.dueAtHelpMember',
                    { member: formatMemberList(presenterAcronyms, locale) },
                    presenterAcronyms.length,
                  )
                : t('agenda.newDocument.dueAtHelp')
            "
            name="dueAt"
          >
            <DocumentDateTimeInput
              v-model="state.dueAt"
              name="dueAt"
              :aria-label="t('agenda.newDocument.dueAt')"
            />
          </UFormField>
        </div>

        <DocumentPresentersField
          v-if="isManager && leadId"
          v-model:co-ids="state.coProponents"
          :main-id="state.mainPresenter"
          voice="manager"
          :lead-id="leadId"
          :members="presentableMembers"
          :known="knownMembers"
          :loading="membersLoading"
          :own-member-id="member?.id ?? null"
          :disabled="saving"
          @update:main-id="onMainPick"
          @load="loadMembers"
        />

        <!-- Managers: the rules in one line; the controls stay folded -->
        <DocumentRulesSummary
          v-if="isManager && state.kind"
          :amendable="state.format !== 'file' && state.amendable"
          :voted="state.voted"
          :majority="state.majority"
          :open="advancedOpen"
          @change="openAdvanced"
        />
        <UCollapsible v-if="isManager" v-model:open="advancedOpen">
          <UButton
            :id="advancedTriggerId"
            color="neutral"
            variant="link"
            size="sm"
            class="px-0"
            :icon="
              advancedOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'
            "
            :label="t('agenda.newDocument.advanced')"
          />
          <template #content>
            <div class="border-default mt-2 space-y-4 rounded-md border p-3">
              <p class="text-muted text-xs">
                {{ t("agenda.newDocument.rulesHelp") }}
              </p>
              <USwitch
                v-model="state.amendable"
                :disabled="state.format === 'file'"
                :label="t('agenda.newDocument.amendable')"
                :description="
                  state.format === 'file'
                    ? t('agenda.newDocument.fileNotAmendable')
                    : undefined
                "
              />
              <DocumentAcceptedRuleField
                v-if="state.format !== 'file' && state.amendable"
                v-model="state.acceptedAmendments"
                :kind="state.kind ?? null"
              />
              <USwitch
                v-model="state.voted"
                :label="t('agenda.newDocument.voted')"
              />
              <UFormField
                v-if="state.voted"
                :label="t('agenda.newDocument.majority')"
                name="majority"
              >
                <URadioGroup
                  v-model="state.majority"
                  :items="majorityItems"
                  value-key="value"
                  orientation="horizontal"
                  variant="card"
                  size="sm"
                  :ui="majorityCardsUi"
                />
              </UFormField>
            </div>
          </template>
        </UCollapsible>
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
          v-if="isManager"
          type="submit"
          form="agenda-new-document-form"
          icon="i-lucide-file-plus"
          :label="t('agenda.newDocument.create')"
          :color="expectsOtherMember ? 'neutral' : 'primary'"
          :variant="expectsOtherMember ? 'outline' : 'solid'"
          :loading="saving && !uploadNow"
          :disabled="saving && uploadNow"
          @click="uploadNow = false"
        />
        <UButton
          v-if="expectsOtherMember"
          type="submit"
          form="agenda-new-document-form"
          icon="i-lucide-file-up"
          :label="
            state.format === 'file'
              ? t('agenda.newDocument.createAndUploadPdf')
              : t('agenda.newDocument.createAndUpload')
          "
          :loading="saving && uploadNow"
          :disabled="saving && !uploadNow"
          @click="uploadNow = true"
        />
        <UButton
          v-if="!isManager"
          type="submit"
          form="agenda-new-document-form"
          trailing-icon="i-lucide-arrow-right"
          :label="t('agenda.newDocument.continue')"
          :loading="saving"
        />
      </div>
    </template>
  </UModal>
</template>
