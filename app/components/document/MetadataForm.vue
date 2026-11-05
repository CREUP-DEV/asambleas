<script setup lang="ts">
import type { FormError, FormErrorEvent, FormSubmitEvent } from "@nuxt/ui";
import {
  DOCUMENT_KIND_DEFAULTS,
  DOCUMENT_KINDS,
  MAJORITIES,
  type AcceptedAmendmentRule,
  type DocumentKind,
  type Majority,
} from "~~/shared/constants/domain";
import type {
  AgendaItemDto,
  AssemblyDto,
  DocumentDto,
  DocumentUpdateBody,
  MemberDto,
  MemberRef,
} from "~~/shared/types/api";
import { formatDateTime, toDate } from "~/utils/format";
import {
  kindSelectItems,
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
  presenterChoiceFromDocument,
  presenterFields,
  samePresenterFields,
  withDefaultMainPresenter,
  withMainAsLead,
  withPresenterLead,
  type PresenterChoice,
} from "~/composables/document/documentPresenters";
import {
  acceptedRuleChange,
  acceptedRuleLocked,
} from "~/composables/document/acceptedRule";

/**
 * Metadata of a document: title, summary, kind, agenda item, presenters,
 * internal deadline, amendable / accepted amendments / voted / majority and
 * the amendment window override. Sends only the fields that changed, with
 * `updatedAt`.
 *
 * Presenters see only what is theirs to fill in: title, type, summary and
 * who presents it with them ("¿Lo presentáis varios miembros?", folded; their
 * own member stays among the presenters), with the agenda item folded under
 * "Más opciones"; the server gives them the defaults of the kind. Everything
 * else needs document:manage (`document.can.manage`): who presents it, with
 * whom and the internal deadline stay in view, and the rules (format,
 * amendments, what an accepted amendment becomes, vote, window) are folded
 * under "Opciones avanzadas". Managers keep this form after publication,
 * when the text is frozen.
 *
 * With several presenters, who answers the amendments (the main presenter)
 * is a required choice; it starts on the lead (the presenter's own member,
 * or the manager's "Quién lo presenta"). For managers "Quién lo presenta"
 * is the main presenter: choosing another one to answer swaps it in, so the
 * form shows what will be stored. Leaving it empty leaves no co-presenters,
 * and the field names the ones that saving would remove.
 *
 * Presenters choose among the types their member usually presents first
 * (the rest under "Otros tipos"); a PDF only offers the types that take no
 * amendments, as when it was created.
 *
 * On a published document, changing what an accepted amendment becomes also
 * changes the amendments already answered, so the form says what saving
 * will do (DocumentAcceptedRuleWarning), by the choice and, while
 * "Opciones avanzadas" is folded, by the save button. Once the text is
 * settled (final vote, consolidated text) the rule is shown but never sent.
 *
 * Emits `saved` with the updated DocumentDto (store it), and `stale` after an
 * optimistic-lock conflict (refetch the document; the form then reloads).
 * `save()` (exposed) validates and stores pending changes without a toast,
 * so a page can save them before sending the document.
 */
const props = withDefaults(
  defineProps<{
    document: DocumentDto;
    assembly: AssemblyDto;
    /**
     * Show "Guardar datos" as a secondary button (the page has its own
     * primary action and saves these changes before it).
     */
    secondarySave?: boolean;
  }>(),
  { secondarySave: false },
);

const emit = defineEmits<{
  saved: [document: DocumentDto];
  stale: [];
}>();

/** True while the form holds unsaved changes. */
const dirty = defineModel<boolean>("dirty", { default: false });

const { t, locale } = useI18n();
const toast = useToast();
const { send, notifyError, isConflict } = useApi();

const TITLE_MAX = 300;
const SUMMARY_MAX = 5_000;

const manager = computed(() => props.document.can.manage);
const isFile = computed(() => props.document.format === "file");
const isPublished = computed(() => props.document.publishedAt !== null);
/** The text is settled: the rule for accepted amendments no longer changes. */
const ruleLocked = computed(() => acceptedRuleLocked(props.document));

interface FormState {
  title: string;
  summary: string;
  kind: DocumentKind;
  agendaItemId: string;
  /**
   * The first presenter: the one managers pick under "Quién lo presenta", or
   * the presenter's own member, fixed (see presenterChoiceFromDocument).
   */
  proponentMemberId: string | null;
  /** The other presenting members. */
  coIds: string[];
  /** Who answers the amendments, among several presenters. */
  mainId: string | null;
  amendable: boolean;
  acceptedAmendments: AcceptedAmendmentRule;
  voted: boolean;
  majority: Majority;
  windowOverride: boolean;
  opensAt: string | null;
  closesAt: string | null;
  dueAt: string | null;
}

const { member: myMember } = useMe();

/**
 * The presenter's own member, which leads (and stays) among the presenters
 * of a document it presents. Managers pick the presenters freely.
 */
const ownPresenterId = computed(() => {
  const id = myMember.value?.id ?? null;
  return !manager.value && isDocumentPresenter(props.document, id) ? id : null;
});

function milestoneAt(key: "amendments_open" | "amendments_close") {
  return props.assembly.milestones.find((m) => m.key === key)?.at ?? null;
}

function sameInstant(a: string | null, b: string | null): boolean {
  const left = toDate(a);
  const right = toDate(b);
  if (!left || !right) return !left && !right;
  return left.getTime() === right.getTime();
}

const calendarOpensAt = computed(() => milestoneAt("amendments_open"));
const calendarClosesAt = computed(() => milestoneAt("amendments_close"));

/** Form state from the stored document (the override as stored, null = calendar). */
function snapshot(document: DocumentDto): FormState {
  const opensAt = document.amendmentsOpenAt;
  const closesAt = document.amendmentsCloseAt;
  const presenters = presenterChoiceFromDocument(
    document,
    ownPresenterId.value,
  );
  return {
    title: document.title,
    summary: document.summary ?? "",
    kind: document.kind,
    agendaItemId: document.agendaItemId,
    proponentMemberId: presenters.leadId,
    coIds: [...presenters.coIds],
    mainId: presenters.mainId,
    amendable: document.amendable,
    // Older servers omit it: the kind's rule.
    acceptedAmendments:
      document.acceptedAmendments ??
      DOCUMENT_KIND_DEFAULTS[document.kind].acceptedAmendments,
    voted: document.voted,
    majority: document.majority,
    windowOverride: opensAt !== null || closesAt !== null,
    opensAt,
    closesAt,
    // Older servers omit it: no deadline.
    dueAt: document.dueAt ?? null,
  };
}

const initial = shallowRef<FormState>(snapshot(props.document));
// Own copy of the co-presenters: the snapshot stays as stored.
const state = reactive<FormState>({
  ...initial.value,
  coIds: [...initial.value.coIds],
});
const saving = ref(false);
const conflictNotice = ref(false);
let resyncNext = false;

function resetForm(): void {
  initial.value = snapshot(props.document);
  Object.assign(state, initial.value, { coIds: [...initial.value.coIds] });
}

/**
 * The presenters as the form will send them: nobody under "Quién lo
 * presenta" leaves no co-presenters (as when creating one).
 */
function choiceOf(form: FormState): PresenterChoice {
  return formPresenterChoice({
    leadId: form.proponentMemberId,
    coIds: form.coIds,
    mainId: form.mainId,
  });
}

const choice = computed(() => choiceOf(state));

/** The window values that would be stored (null = follow the calendar). */
const desiredWindow = computed(() => ({
  opensAt: state.windowOverride ? state.opensAt : null,
  closesAt: state.windowOverride ? state.closesAt : null,
}));

function buildBody(): DocumentUpdateBody {
  const before = initial.value;
  const body: DocumentUpdateBody = { updatedAt: props.document.updatedAt };
  const title = state.title.trim();
  if (title !== before.title) body.title = title;
  const summary = state.summary.trim();
  if (summary !== before.summary.trim()) body.summary = summary || null;
  if (state.kind !== before.kind) body.kind = state.kind;
  if (state.agendaItemId !== before.agendaItemId)
    body.agendaItemId = state.agendaItemId;

  // Presenters choose the members presenting it with them, managers anyone.
  const presenters = presenterFields(choice.value);
  const stored = presenterFields(choiceOf(before));
  if (!samePresenterFields(presenters, stored)) {
    if (presenters.proponentMemberId !== stored.proponentMemberId)
      body.proponentMemberId = presenters.proponentMemberId;
    if (
      !samePresenterFields(
        { ...presenters, proponentMemberId: null },
        { ...stored, proponentMemberId: null },
      )
    )
      body.coProponentMemberIds = presenters.coProponentMemberIds;
  }
  if (!manager.value) return body;

  const amendable = isFile.value ? false : state.amendable;
  if (amendable !== before.amendable) body.amendable = amendable;
  // A settled document keeps its rule (the server would refuse it).
  if (
    amendable &&
    !ruleLocked.value &&
    state.acceptedAmendments !== before.acceptedAmendments
  )
    body.acceptedAmendments = state.acceptedAmendments;
  if (state.voted !== before.voted) body.voted = state.voted;
  if (state.majority !== before.majority) body.majority = state.majority;
  if (!sameInstant(desiredWindow.value.opensAt, before.opensAt))
    body.amendmentsOpenAt = desiredWindow.value.opensAt;
  if (!sameInstant(desiredWindow.value.closesAt, before.closesAt))
    body.amendmentsCloseAt = desiredWindow.value.closesAt;
  if (!sameInstant(state.dueAt, before.dueAt)) body.dueAt = state.dueAt;
  return body;
}

const changedCount = computed(
  () => Object.keys(buildBody()).filter((key) => key !== "updatedAt").length,
);

watch(
  changedCount,
  (count) => {
    dirty.value = count > 0;
    if (count > 0) conflictNotice.value = false;
  },
  { immediate: true },
);

// Reload from the server copy when it changes, unless the user is editing.
watch(
  () => props.document.updatedAt,
  () => {
    if (resyncNext || !dirty.value) {
      resyncNext = false;
      resetForm();
    }
  },
);

// Managers: another "Quién lo presenta" leaves the co-presenters, and answers
// the amendments if the previous one did. A reload sets lead and main alike,
// so it comes through unchanged.
watch(
  () => state.proponentMemberId,
  (next, previous) => {
    if (!manager.value) return;
    const updated = withPresenterLead(
      { leadId: previous, coIds: state.coIds, mainId: state.mainId },
      next,
    );
    state.coIds = [...updated.coIds];
    state.mainId = updated.mainId;
  },
);

// Several presenters and none of them answering: the lead answers until
// another one is chosen (a stored document already has its main one).
watch(
  () => choicePresenterIds(choice.value).join(),
  () => {
    const next = withDefaultMainPresenter(choice.value);
    if (next.mainId !== state.mainId) state.mainId = next.mainId;
  },
);

/**
 * Who answers the amendments was chosen. Managers: the chosen presenter
 * becomes "Quién lo presenta" and the previous one a co-presenter (the
 * watcher on the lead then keeps both).
 */
function onMainPick(id: string | null): void {
  if (!manager.value) {
    state.mainId = id;
    return;
  }
  const next = withMainAsLead(choice.value, id);
  state.coIds = [...next.coIds];
  state.mainId = next.mainId;
  state.proponentMemberId = next.leadId;
}

// Kind defaults ---------------------------------------------------------------

const kindDefaults = computed(() => DOCUMENT_KIND_DEFAULTS[state.kind]);
const kindChanged = computed(() => state.kind !== initial.value.kind);

/** What presenters will get: the server applies the kind defaults. */
const effective = computed(() => {
  if (manager.value || !kindChanged.value) {
    return {
      amendable: isFile.value ? false : state.amendable,
      acceptedAmendments: state.acceptedAmendments,
      voted: state.voted,
      majority: state.majority,
    };
  }
  return {
    amendable: isFile.value ? false : kindDefaults.value.amendable,
    acceptedAmendments: kindDefaults.value.acceptedAmendments,
    voted: kindDefaults.value.voted,
    majority: kindDefaults.value.majority,
  };
});

const differsFromDefaults = computed(
  () =>
    manager.value &&
    ((!isFile.value && state.amendable !== kindDefaults.value.amendable) ||
      (effective.value.amendable &&
        !ruleLocked.value &&
        state.acceptedAmendments !== kindDefaults.value.acceptedAmendments) ||
      state.voted !== kindDefaults.value.voted ||
      state.majority !== kindDefaults.value.majority),
);

function applyKindDefaults(): void {
  if (!isFile.value) state.amendable = kindDefaults.value.amendable;
  if (!ruleLocked.value)
    state.acceptedAmendments = kindDefaults.value.acceptedAmendments;
  state.voted = kindDefaults.value.voted;
  state.majority = kindDefaults.value.majority;
}

/**
 * The rule saving would switch a published document to, when that changes
 * amendments already answered (only sent while the document is amendable).
 */
const ruleChange = computed(() =>
  manager.value && effective.value.amendable
    ? acceptedRuleChange({
        published: isPublished.value,
        locked: ruleLocked.value,
        stored: initial.value.acceptedAmendments,
        next: state.acceptedAmendments,
      })
    : null,
);
const mainPresenterAcronym = computed(
  () => props.document.proponent?.acronym ?? null,
);

// Options -----------------------------------------------------------------

/**
 * Managers get every type. Presenters get the usual ones of their member
 * first, and a PDF only the types that take no amendments (the server
 * would silently store it without them otherwise).
 */
const kindItems = computed(() => {
  const label = (kind: DocumentKind) => t(`document.kinds.${kind}`);
  if (manager.value) {
    return DOCUMENT_KINDS.map((kind) => ({ label: label(kind), value: kind }));
  }
  return kindSelectItems(
    presenterKindGroups({
      memberKind: props.document.proponent?.kind ?? myMember.value?.kind,
      format: props.document.format,
      current: initial.value.kind,
    }),
    label,
    {
      common: t("document.kindGroups.common"),
      others: t("document.kindGroups.others"),
    },
  );
});

const majorityItems = computed(() =>
  MAJORITIES.map((majority) => ({
    label: t(`document.majorities.${majority}`),
    value: majority,
  })),
);

// Shared with the hub's agenda pages (same key, refreshed on live events).
const { data: agenda, status: agendaStatus } = useAssemblyAgenda();

const agendaItems = computed(() => {
  const items = agenda.value?.items ?? [];
  const children = new Map<string | null, AgendaItemDto[]>();
  for (const item of items) {
    const list = children.get(item.parentId) ?? [];
    list.push(item);
    children.set(item.parentId, list);
  }
  const result: { label: string; value: string; disabled: boolean }[] = [];
  const visit = (parentId: string | null, depth: number) => {
    const list = (children.get(parentId) ?? [])
      .slice()
      .sort((a, b) => a.order - b.order);
    for (const item of list) {
      result.push({
        label: `${"\u2003".repeat(depth)}${item.title}`,
        value: item.id,
        disabled:
          !manager.value &&
          !item.acceptsSubmissions &&
          item.id !== initial.value.agendaItemId,
      });
      visit(item.id, depth + 1);
    }
  };
  visit(null, 0);
  return result;
});

const currentAgendaTitle = computed(
  () =>
    agenda.value?.items.find((item) => item.id === state.agendaItemId)?.title ??
    null,
);

const {
  data: members,
  status: membersStatus,
  execute: fetchMembers,
} = useFetch<MemberDto[]>("/api/members", {
  key: "members:active",
  lazy: true,
  default: () => [],
  immediate: manager.value,
});

/** Presenters load the members when they unfold "varios miembros". */
function loadMembers(): void {
  if (membersStatus.value === "idle") void fetchMembers();
}

/** Members to name among the presenters, even if inactive or not loaded. */
const knownMembers = computed<MemberRef[]>(() => [
  ...documentPresenterMembers(props.document),
  ...(myMember.value ? [myMember.value] : []),
]);

/**
 * A co-presenter keeps the main presenter: only that member, or the
 * Secretaría, hands over answering the amendments.
 */
const mainLocked = computed(
  () =>
    ownPresenterId.value !== null &&
    props.document.proponent !== null &&
    props.document.proponent.id !== ownPresenterId.value,
);
const fixedPresenterIds = computed(() =>
  mainLocked.value && props.document.proponent
    ? [props.document.proponent.id]
    : [],
);

/** The presenter's own member, shown as theirs. */
const ownPresenter = computed(() =>
  ownPresenterId.value
    ? (knownMembers.value.find((item) => item.id === ownPresenterId.value) ??
      null)
    : null,
);

const memberItems = computed(() => {
  const list = (members.value ?? []).map((member) => ({
    label: member.acronym,
    description: member.name,
    value: member.id,
  }));
  // Current presenters stay pickable even if inactive: one may become
  // "Quién lo presenta" by being chosen to answer the amendments.
  const missing = documentPresenterMembers(props.document)
    .filter((current) => !list.some((item) => item.value === current.id))
    .map((current) => ({
      label: current.acronym,
      description: current.name,
      value: current.id,
    }));
  return [...missing, ...list];
});

/**
 * Managers: nobody under "Quién lo presenta" removes the co-presenters the
 * form still holds when saving; name them under the field.
 */
const droppedHelp = computed(() => {
  if (!manager.value) return undefined;
  const dropped = coPresentersDroppedWithoutLead({
    leadId: state.proponentMemberId,
    coIds: state.coIds,
    mainId: state.mainId,
  });
  if (dropped.length === 0) return undefined;
  const acronyms = dropped.map(
    (id) =>
      knownMembers.value.find((item) => item.id === id)?.acronym ??
      members.value?.find((item) => item.id === id)?.acronym ??
      id,
  );
  return t(
    "document.presenters.droppedWithoutLead",
    { members: formatMemberList(acronyms, locale.value) },
    acronyms.length,
  );
});

// Window hints ------------------------------------------------------------

function calendarHint(value: string | null): string {
  return value
    ? t("document.metadata.calendarValue", {
        date: formatDateTime(value, { locale: locale.value }),
      })
    : t("document.metadata.calendarNone");
}

function onOverrideToggle(enabled: boolean): void {
  if (enabled) {
    state.opensAt ??= props.document.window.opensAt ?? calendarOpensAt.value;
    state.closesAt ??= props.document.window.closesAt ?? calendarClosesAt.value;
  }
}

const showWindow = computed(
  () => manager.value && !isFile.value && state.amendable,
);

/** The internal deadline matters until the document is published. */
const showDueAt = computed(
  () => manager.value && props.document.publishedAt === null,
);

// Folded sections -----------------------------------------------------------

/** Managers: format, amendments, vote and window. */
const advancedOpen = ref(false);
/** Presenters: the agenda item. */
const moreOpen = ref(false);

/** Open the folded section that holds a field with an error. */
function revealErrors(names: (string | undefined)[]): void {
  if (names.some((name) => name === "opensAt" || name === "closesAt")) {
    advancedOpen.value = true;
  }
}

function onError(event: FormErrorEvent): void {
  revealErrors(event.errors.map((error) => error.name));
}

// Validation and submit -----------------------------------------------------

function validate(current: Partial<FormState>): FormError[] {
  const errors: FormError[] = [];
  const title = (current.title ?? "").trim();
  if (!title)
    errors.push({
      name: "title",
      message: t("document.metadata.errors.titleRequired"),
    });
  else if (title.length > TITLE_MAX)
    errors.push({
      name: "title",
      message: t("document.metadata.errors.titleTooLong", { max: TITLE_MAX }),
    });
  if ((current.summary ?? "").trim().length > SUMMARY_MAX)
    errors.push({
      name: "summary",
      message: t("document.metadata.errors.summaryTooLong", {
        max: SUMMARY_MAX,
      }),
    });
  if (mainPresenterMissing(choice.value))
    errors.push({
      name: "mainPresenter",
      message: t("document.presenters.mainRequired"),
    });
  if (current.windowOverride && showWindow.value) {
    const opens = toDate(current.opensAt ?? null);
    const closes = toDate(current.closesAt ?? null);
    if (opens && closes && closes <= opens)
      errors.push({
        name: "closesAt",
        message: t("document.metadata.errors.closeBeforeOpen"),
      });
  }
  return errors;
}

let inflight: Promise<boolean> | null = null;

/** PUT the changed fields. Resolves to true once they are stored. */
function persist(notify: boolean): Promise<boolean> {
  if (inflight) return inflight;
  if (changedCount.value === 0) return Promise.resolve(true);
  inflight = doPersist(notify).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function doPersist(notify: boolean): Promise<boolean> {
  saving.value = true;
  try {
    const updated = await send<DocumentDto>(
      `/api/assemblies/${encodeURIComponent(props.assembly.id)}/documents/${encodeURIComponent(props.document.id)}`,
      { method: "PUT", body: buildBody() },
    );
    resyncNext = true;
    emit("saved", updated);
    if (notify) {
      toast.add({
        title: t("document.metadata.saved"),
        color: "success",
        icon: "i-lucide-check",
      });
    }
    return true;
  } catch (error) {
    notifyError(error, "document.metadata.saveError");
    if (isConflict(error)) {
      conflictNotice.value = true;
      resyncNext = true;
      emit("stale");
    }
    return false;
  } finally {
    saving.value = false;
  }
}

async function onSubmit(_event: FormSubmitEvent<FormState>): Promise<void> {
  await persist(true);
}

interface FormHandle {
  validate: (options: { silent: true }) => Promise<unknown>;
  errors: { id?: string; name?: string }[];
}
const form = useTemplateRef<FormHandle>("form");

/**
 * Validates the pending changes without storing them (nothing pending
 * resolves to true). On invalid data it shows the errors, opens their
 * section, brings the first one into view with the focus and resolves to
 * false. Call it before opening a dialog: a modal keeps the focus.
 */
async function check(): Promise<boolean> {
  if (changedCount.value === 0 || !form.value) return true;
  if ((await form.value.validate({ silent: true })) !== false) return true;
  const errors = form.value.errors ?? [];
  revealErrors(errors.map((error) => error.name));
  toast.add({
    title: t("document.metadata.invalid"),
    color: "warning",
    icon: "i-lucide-circle-alert",
  });
  await nextTick();
  const first = errors.find((error) => error.id)?.id;
  const field = first ? window.document.getElementById(first) : null;
  field?.scrollIntoView({ block: "center" });
  field?.focus({ preventScroll: true });
  return false;
}

/**
 * Validates and stores the pending changes without a toast (nothing to do
 * resolves to true). Resolves to false on invalid data (see `check`), a
 * conflict (the form shows its notice) or a failed request.
 */
async function save(): Promise<boolean> {
  if (!inflight && changedCount.value === 0) return true;
  if (!(await check())) return false;
  return persist(false);
}

defineExpose({ reset: resetForm, check, save });
</script>

<template>
  <UForm
    ref="form"
    :state="state"
    :validate="validate"
    :validate-on="['blur', 'change']"
    class="space-y-4"
    @submit="onSubmit"
    @error="onError"
  >
    <UAlert
      v-if="conflictNotice"
      color="warning"
      variant="subtle"
      icon="i-lucide-refresh-ccw"
      :title="t('document.metadata.conflictTitle')"
      :description="t('document.metadata.conflictDescription')"
      role="alert"
    />

    <UFormField name="title" :label="t('document.metadata.title')" required>
      <UInput
        v-model="state.title"
        :maxlength="TITLE_MAX"
        class="w-full"
        autocomplete="off"
      />
    </UFormField>

    <UFormField name="kind" :label="t('document.metadata.kind')" required>
      <USelect v-model="state.kind" :items="kindItems" class="w-full" />
    </UFormField>

    <UFormField
      name="summary"
      :label="t('document.metadata.summary')"
      :hint="t('document.metadata.optional')"
      :description="t('document.metadata.summaryDescription')"
    >
      <UTextarea
        v-model="state.summary"
        :maxlength="SUMMARY_MAX"
        :rows="3"
        autoresize
        :maxrows="10"
        class="w-full"
      />
    </UFormField>

    <!-- Presenters: their member, who presents it with them, the agenda item -->
    <template v-if="!manager">
      <template v-if="ownPresenter">
        <p class="text-muted flex flex-wrap items-center gap-2 text-sm">
          {{ t("agenda.newDocument.presentingAs") }}
          <CommonMemberBadge :member="ownPresenter" show-name />
        </p>
        <DocumentPresentersField
          v-model:co-ids="state.coIds"
          v-model:main-id="state.mainId"
          voice="presenter"
          :lead-id="state.proponentMemberId"
          :members="members ?? []"
          :known="knownMembers"
          :loading="membersStatus === 'pending'"
          :own-member-id="ownPresenter.id"
          :fixed-ids="fixedPresenterIds"
          :main-locked="mainLocked"
          :disabled="saving"
          @load="loadMembers"
        />
      </template>
      <p
        v-else-if="document.proponent"
        class="text-muted flex flex-wrap items-center gap-2 text-sm"
      >
        {{ t("document.metadata.presentedBy") }}
        <DocumentPresenters :document="document" />
      </p>

      <UCollapsible v-model:open="moreOpen">
        <UButton
          color="neutral"
          variant="link"
          size="sm"
          class="px-0"
          :icon="moreOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
          :label="t('document.metadata.more')"
        />
        <template #content>
          <div class="pt-2">
            <UFormField
              name="agendaItemId"
              :label="t('document.metadata.agendaItem')"
              :description="t('document.metadata.agendaItemHelp')"
            >
              <USkeleton
                v-if="agendaStatus === 'pending' && !agenda"
                class="h-8 w-full"
              />
              <USelect
                v-else-if="agendaItems.length > 0"
                v-model="state.agendaItemId"
                :items="agendaItems"
                class="w-full"
              />
              <p v-else class="text-muted text-sm">
                {{
                  currentAgendaTitle ?? t("document.metadata.agendaUnavailable")
                }}
              </p>
            </UFormField>
          </div>
        </template>
      </UCollapsible>
    </template>

    <!-- Managers: where it goes, who presents it and by when -->
    <template v-else>
      <UFormField
        name="agendaItemId"
        :label="t('document.metadata.agendaItem')"
      >
        <USkeleton
          v-if="agendaStatus === 'pending' && !agenda"
          class="h-8 w-full"
        />
        <USelect
          v-else-if="agendaItems.length > 0"
          v-model="state.agendaItemId"
          :items="agendaItems"
          class="w-full"
        />
        <p v-else class="text-muted text-sm">
          {{ currentAgendaTitle ?? t("document.metadata.agendaUnavailable") }}
        </p>
      </UFormField>

      <UFormField
        name="proponentMemberId"
        :label="t('document.metadata.proponent')"
        :help="droppedHelp"
      >
        <USelectMenu
          v-model="state.proponentMemberId"
          :items="memberItems"
          value-key="value"
          :filter-fields="['label', 'description']"
          :loading="membersStatus === 'pending'"
          :placeholder="t('document.metadata.proponentPlaceholder')"
          :search-input="{ placeholder: t('document.metadata.searchMember') }"
          clear
          class="w-full"
        />
      </UFormField>

      <DocumentPresentersField
        v-if="state.proponentMemberId"
        v-model:co-ids="state.coIds"
        :main-id="state.mainId"
        voice="manager"
        :lead-id="state.proponentMemberId"
        :members="members ?? []"
        :known="knownMembers"
        :loading="membersStatus === 'pending'"
        :own-member-id="myMember?.id ?? null"
        :disabled="saving"
        @update:main-id="onMainPick"
        @load="loadMembers"
      />

      <UFormField
        v-if="showDueAt"
        name="dueAt"
        :label="t('document.metadata.dueAt')"
        :hint="t('document.metadata.optional')"
        :description="t('document.metadata.dueAtDescription')"
      >
        <DocumentDateTimeInput v-model="state.dueAt" name="dueAt" />
      </UFormField>

      <UCollapsible v-model:open="advancedOpen">
        <UButton
          color="neutral"
          variant="link"
          size="sm"
          class="px-0"
          :icon="advancedOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
          :label="t('document.metadata.advanced')"
        />
        <template #content>
          <div class="space-y-4 pt-2">
            <UFormField name="format" :label="t('document.metadata.format')">
              <p class="text-default flex items-center gap-2 text-sm">
                <UIcon
                  :name="isFile ? 'i-lucide-file-text' : 'i-lucide-text'"
                  class="text-muted size-4"
                  aria-hidden="true"
                />
                {{ t(`document.formats.${document.format}`) }}
              </p>
            </UFormField>

            <div class="space-y-3">
              <div class="flex items-center justify-between gap-2">
                <h4 class="text-highlighted text-sm font-semibold">
                  {{ t("document.metadata.procedure") }}
                </h4>
                <UButton
                  v-if="differsFromDefaults"
                  size="xs"
                  color="neutral"
                  variant="link"
                  icon="i-lucide-rotate-ccw"
                  :label="t('document.metadata.applyDefaults')"
                  @click="applyKindDefaults"
                />
              </div>

              <UFormField
                name="amendable"
                :description="
                  isFile ? t('document.metadata.fileNotAmendable') : undefined
                "
              >
                <USwitch
                  v-model="state.amendable"
                  :disabled="isFile"
                  :label="t('document.metadata.amendable')"
                />
              </UFormField>

              <DocumentAcceptedRuleField
                v-if="effective.amendable"
                v-model="state.acceptedAmendments"
                :kind="state.kind"
                :published="isPublished"
                :stored="initial.acceptedAmendments"
                :locked="ruleLocked"
                :presenter="mainPresenterAcronym"
              />

              <UFormField name="voted">
                <USwitch
                  v-model="state.voted"
                  :label="t('document.metadata.voted')"
                />
              </UFormField>

              <UFormField
                v-if="effective.voted"
                name="majority"
                :label="t('document.metadata.majority')"
              >
                <USelect
                  v-model="state.majority"
                  :items="majorityItems"
                  class="w-full"
                />
              </UFormField>
            </div>

            <div v-if="showWindow" class="space-y-3">
              <UFormField
                name="windowOverride"
                :description="t('document.metadata.windowOverrideDescription')"
              >
                <USwitch
                  v-model="state.windowOverride"
                  :label="t('document.metadata.windowOverride')"
                  @update:model-value="onOverrideToggle"
                />
              </UFormField>

              <template v-if="state.windowOverride">
                <UFormField
                  name="opensAt"
                  :label="t('document.metadata.opensAt')"
                  :description="calendarHint(calendarOpensAt)"
                  :hint="t('document.metadata.timeZone')"
                >
                  <DocumentDateTimeInput v-model="state.opensAt" />
                </UFormField>
                <UFormField
                  name="closesAt"
                  :label="t('document.metadata.closesAt')"
                  :description="calendarHint(calendarClosesAt)"
                  :hint="t('document.metadata.timeZone')"
                >
                  <DocumentDateTimeInput
                    v-model="state.closesAt"
                    :min="state.opensAt"
                  />
                </UFormField>
              </template>
            </div>
          </div>
        </template>
      </UCollapsible>
    </template>

    <!-- The rule change, still in view when its section is folded -->
    <DocumentAcceptedRuleWarning
      v-if="ruleChange && !advancedOpen"
      :change="ruleChange"
      :member="mainPresenterAcronym"
    />

    <div class="flex flex-wrap items-center justify-end gap-2 pt-1">
      <UButton
        v-if="dirty"
        color="neutral"
        variant="ghost"
        :label="t('document.metadata.reset')"
        :disabled="saving"
        @click="resetForm"
      />
      <UButton
        type="submit"
        icon="i-lucide-save"
        :color="secondarySave ? 'neutral' : 'primary'"
        :variant="secondarySave ? 'outline' : 'solid'"
        :label="t('document.metadata.save')"
        :loading="saving"
        :disabled="!dirty"
      />
    </div>
  </UForm>
</template>
