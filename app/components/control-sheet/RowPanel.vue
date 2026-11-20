<script setup lang="ts">
import {
  CONTROL_SHEET_MANUAL_RESULTS,
  type ControlSheetManualResult,
} from "~~/shared/constants/domain";
import type {
  AmendmentDto,
  AmendmentOutcomeDto,
  ControlSheetAmendmentBody,
  ControlSheetAmendmentRowDto,
  ControlSheetEditDto,
  ControlSheetHistoryDto,
  ControlSheetItemBody,
  ControlSheetItemRowDto,
  DocumentSummaryDto,
  SpeakingTurnDto,
  VoteDto,
} from "~~/shared/types/api";
import { CONTROL_SHEET_OBSERVATIONS_MAX_LENGTH } from "~~/shared/utils/schemas/controlSheet";
import {
  amendmentTreatedControl,
  itemTreatedControl,
  staleSheetRow,
  type AmendmentSheetRow,
  type GeneralSheetRow,
  type ItemVoteContext,
  type TreatedControl,
} from "./-model";
import {
  LEAVE_SAVE_WAIT_MS,
  keepMyObservations,
  newObservationDraft,
  observationConflicted,
  observationDirty,
  observationSaved,
  observationUnsaved,
  releaseObservationDraft,
  settledWithin,
  syncObservationDraft,
  takeTheirObservations,
  unsavedObservationIds,
  type ObservationDraft,
} from "./-drafts";

/**
 * Everything one row of the control sheet edits, in a side panel: the
 * observations (shared, with who wrote each version and a way back to an
 * earlier one), the result noted by hand, the Mesa's treated mark, the
 * votes on an item (ItemVotes), the presenter's answer to an amendment
 * (PositionAnswer, for whoever may answer it), who spoke on it (noted by
 * whoever notes the speakers, SpeakerNotesEditor), and the history. Each field
 * saves on its
 * own with its own lock token (the treated mark through the page:
 * `treated`, `treatedPending`; the lists only show it); a field someone
 * else changed meanwhile shows what is there now (and, for the
 * observations, both texts to choose). The draft is kept apart from fetched data, so a refetch while
 * typing never replaces it, and apart for each row (-drafts.ts): closing
 * the panel or opening another row while it saves never loses it. What
 * could not be saved once the panel left its row (a conflict, the network)
 * stays in its row and says so in one notice that opens it again; leaving
 * the page with it asks first.
 */

export type RowPanelTarget =
  | { kind: "item"; row: GeneralSheetRow }
  | { kind: "amendment"; row: AmendmentSheetRow; code: string };

const props = defineProps<{
  target: RowPanelTarget | null;
  apiBase: string;
  /**
   * `internal`: a sheet key (ControlSheetDto.can.internal). Without it the
   * panel shows only what is public: the result, the presenter's answer and
   * the votes; never the Mesa's switch (the lists show whether it was
   * treated), a result by hand, who spoke, the observations nor their
   * history (user's decision of 2026-11-19).
   */
  can: { internal: boolean; edit: boolean; moderate: boolean };
  /** The treated mark on its way for this row. */
  treatedPending?: boolean;
  /** What the votes on an item depend on besides the row. */
  voteContext: ItemVoteContext;
  /** The document of an amendment's row: who answers it, and its rule. */
  document?: DocumentSummaryDto | null;
  /** Every turn that spoke in the assembly (ControlSheetDto.turns). */
  speakerTurns?: readonly SpeakingTurnDto[];
  /**
   * Recording results here (the Mesa and assembly:vote_result; user's
   * decision of 2026-11-19), never projected: the document's amendments as
   * loaded, and whether the document of an amendment's row has its final
   * vote.
   */
  results?: {
    record: boolean;
    amendments: readonly AmendmentDto[];
    finalVoted: boolean;
  };
  /**
   * Noting who spoke: `note` for the Mesa and session:record_speakers,
   * `open` while the assembly takes notes (convened, in session).
   */
  speakers?: { note: boolean; open: boolean };
}>();
const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{
  itemSaved: [row: ControlSheetItemRowDto];
  amendmentSaved: [row: ControlSheetAmendmentRowDto];
  /** The Mesa changed the treated mark: the page saves it. */
  treated: [value: boolean];
  /** A vote on the item changed (null: a write failed, fetch again). */
  voteChanged: [vote: VoteDto | null];
  /** The presenter's answer to the amendment changed. */
  positionSaved: [amendment: AmendmentDto];
  /**
   * Someone was noted as having spoken, or taken back: every turn that
   * spoke in the assembly as the notes answered, for the page to show at
   * once.
   */
  speakersUpdated: [turns: SpeakingTurnDto[]];
  /**
   * A result was recorded or annulled here: the amendment as it stands now
   * (null: a document's final vote, or a write that failed), for the page
   * to show at once before it fetches again.
   */
  resultChanged: [outcome: AmendmentOutcomeDto | null];
  /**
   * Open the panel on this row again: the reader asked for it from the
   * notice of its unsaved observations.
   */
  reopen: [target: RowPanelTarget];
}>();

const { t, locale } = useI18n();
const api = useApi();
const toast = useToast();

const subjectId = computed(() =>
  props.target?.kind === "item"
    ? props.target.row.id
    : (props.target?.row.amendment.id ?? null),
);
const sheetRow = computed<
  ControlSheetItemRowDto | ControlSheetAmendmentRowDto | null
>(() => props.target?.row.sheet ?? null);
const url = computed(() => {
  if (!props.target || !subjectId.value) return null;
  const segment = props.target.kind === "item" ? "items" : "amendments";
  return `${props.apiBase}/control-sheet/${segment}/${encodeURIComponent(subjectId.value)}`;
});

function titleOf(target: RowPanelTarget | null | undefined): string {
  if (!target) return "";
  if (target.kind === "amendment") return target.code;
  return numberedAgendaTitle(
    target.row.number,
    target.row.title,
    t("agenda.unlisted.inText"),
  );
}
const title = computed(() => titleOf(props.target));

function when(edit: ControlSheetEditDto): string {
  return formatMoment(edit.at, { locale: locale.value }).text;
}

function editedLine(edit: ControlSheetEditDto | null): string {
  if (!edit) return "";
  return edit.by
    ? t("controlSheet.panel.edited", { name: edit.by, when: when(edit) })
    : t("controlSheet.panel.editedNoName", { when: when(edit) });
}

type SheetRow = ControlSheetItemRowDto | ControlSheetAmendmentRowDto;

/** Hands a saved row to the page, as the kind of row it was sent for. */
function applySaved(kind: "item" | "amendment", row: SheetRow): void {
  if (kind === "item") emit("itemSaved", row as ControlSheetItemRowDto);
  else emit("amendmentSaved", row as ControlSheetAmendmentRowDto);
}

async function patch(
  target: string,
  body: ControlSheetItemBody | ControlSheetAmendmentBody,
): Promise<SheetRow> {
  return api.send(target, { method: "PATCH", body: { ...body } });
}

// Observations ---------------------------------------------------------------

/** Each row's observations as written here, by item or amendment id. */
const drafts = reactive(new Map<string, ObservationDraft>()) as Map<
  string,
  ObservationDraft
>;
/** Where each entry saves, and the row to open again for it. */
const draftPlaces = new Map<
  string,
  { kind: "item" | "amendment"; url: string; target: RowPanelTarget }
>();
/** The saves on their way, by row: closing waits for its row's. */
const savesOnTheWay = new Map<string, Promise<boolean>>();

/** The row on show's entry. */
const shownDraft = computed(() =>
  subjectId.value ? (drafts.get(subjectId.value) ?? null) : null,
);
const draft = computed<string>({
  get: () => shownDraft.value?.draft ?? "",
  set: (value) => {
    if (shownDraft.value) shownDraft.value.draft = value;
  },
});
const saving = computed(() => Boolean(shownDraft.value?.saving));
const savedAt = computed(() => shownDraft.value?.savedAt ?? null);
const conflict = computed(() => shownDraft.value?.conflict ?? null);
const dirty = computed(() =>
  shownDraft.value ? observationDirty(shownDraft.value) : false,
);

/** The presenter's answer chosen in the panel, saved with the rest. */
const positionAnswer = ref<{
  editable: boolean;
  dirty: boolean;
  saving: boolean;
  save: () => Promise<boolean>;
} | null>(null);
const positionDirty = computed(() => Boolean(positionAnswer.value?.dirty));
/** Anything in the panel waiting for «Guardar». */
const anyDirty = computed(() => dirty.value || positionDirty.value);
const anySaving = computed(
  () => saving.value || Boolean(positionAnswer.value?.saving),
);

/**
 * The one «Guardar»: the observations and the answer, whichever changed.
 * Whether everything was saved (false: a conflict to choose from, or a
 * failure, which keeps the text).
 */
async function saveAll(): Promise<boolean> {
  const [observations, answer] = await Promise.all([
    dirty.value || conflict.value ? saveObservations() : Promise.resolve(true),
    positionDirty.value
      ? (positionAnswer.value?.save() ?? Promise.resolve(true))
      : Promise.resolve(true),
  ]);
  return observations && answer;
}

/** The row's entry: the one kept for it, or a new one from its text. */
function showDraft(id: string): void {
  if (!drafts.has(id)) drafts.set(id, newObservationDraft(sheetRow.value));
  rememberPlace(id);
}

/** Where row `id` saves, while the panel shows it. */
function rememberPlace(id: string): void {
  if (!props.target || !url.value || subjectId.value !== id) return;
  draftPlaces.set(id, {
    kind: props.target.kind,
    url: url.value,
    target: props.target,
  });
}

/** Row `id` has nothing left to keep: its entry and its notice go. */
function forgetDraft(id: string): void {
  releaseObservationDraft(drafts, id);
  if (!drafts.has(id)) {
    draftPlaces.delete(id);
    toast.remove(unsavedNoticeId(id));
  }
}

// Another row opened: its own entry, the one kept for it or a new one; the
// row left keeps its entry only while it has something to keep (a save on
// its way, a draft, a conflict), and says so in its notice unless a save is
// on its way (its answer will). The panel losing its row for a moment (a
// refetch, the debate moving) keeps everything.
let shownSubject: string | null = subjectId.value;
watch(subjectId, (id) => {
  if (!id || id === shownSubject) return;
  const left = shownSubject;
  if (left) {
    forgetDraft(left);
    const kept = drafts.get(left);
    if (kept && !kept.saving && observationUnsaved(kept)) noticeUnsaved(left);
  }
  shownSubject = id;
  showDraft(id);
  history.value = null;
  historyOpen.value = false;
});
// The row brought up to date by a refetch: where it saves, and the row to
// open again, are its fresh ones.
watch(
  () => props.target,
  () => {
    if (subjectId.value) rememberPlace(subjectId.value);
  },
);
// A refetch brings someone else's text: take it unless the reader is typing.
watch(
  () => [sheetRow.value?.observationsUpdatedAt, sheetRow.value?.observations],
  () => {
    const current = shownDraft.value;
    if (!current) return;
    const token = sheetRow.value?.observationsUpdatedAt ?? null;
    if (observationDirty(current) || current.saving) return;
    if (token === current.base.token) return;
    syncObservationDraft(current, sheetRow.value);
    current.savedAt = null;
  },
);
if (subjectId.value) showDraft(subjectId.value);

/** The panel is open on row `id`, where its problems show by themselves. */
function shownHere(id: string): boolean {
  return open.value && subjectId.value === id;
}

/** The page was left (after asking): no notice can open a row any more. */
let gone = false;

function unsavedNoticeId(id: string): string {
  return `control-sheet-unsaved-${id}`;
}

/**
 * One notice for a row whose observations are not saved and no longer on
 * show (the panel closed, or on another row): it stays until they are
 * saved or the reader opens the row again from it.
 */
function noticeUnsaved(id: string): void {
  const place = draftPlaces.get(id);
  // A save that answers after the page was left could open nothing.
  if (!place || gone) return;
  toast.add({
    id: unsavedNoticeId(id),
    title: t("controlSheet.panel.unsavedNotice", {
      row: titleOf(place.target),
    }),
    color: "warning",
    icon: "i-lucide-triangle-alert",
    duration: Number.POSITIVE_INFINITY,
    actions: [
      {
        label: t("controlSheet.panel.unsavedOpen"),
        color: "warning",
        variant: "outline",
        onClick: () => {
          toast.remove(unsavedNoticeId(id));
          emit("reopen", place.target);
        },
      },
    ],
  });
}

/**
 * Saves row `id`'s observations (the row on show by default), and says
 * whether they are saved: false while two versions wait for the reader's
 * choice, or when the save failed (the text stays). The answer lands on that
 * row's entry, whichever row the panel shows by then; a save already on its
 * way is waited for first.
 */
async function saveObservations(
  id: string | null = subjectId.value,
): Promise<boolean> {
  const current = id ? drafts.get(id) : undefined;
  const place = id ? draftPlaces.get(id) : undefined;
  if (!id || !current || !place) return true;
  // While two versions are shown, only the reader's choice saves.
  if (current.conflict) return false;
  if (!props.can.edit) return true;
  const onTheWay = savesOnTheWay.get(id);
  if (onTheWay) {
    // What was typed while it saved goes next.
    return (await onTheWay) && saveObservations(id);
  }
  if (!observationDirty(current)) return true;
  const sent = current.draft;
  current.saving = true;
  const run = (async (): Promise<boolean> => {
    try {
      const row = await patch(place.url, {
        observations: { value: sent, updatedAt: current.base.token },
      });
      applySaved(place.kind, row);
      observationSaved(current, sent, row, Date.now());
      if (shownHere(id) && historyOpen.value) void loadHistory();
      return true;
    } catch (error) {
      const row = staleSheetRow<SheetRow>(error);
      if (row) {
        applySaved(place.kind, row);
        observationConflicted(current, row);
      }
      // On show, the conflict is in the panel and a failure says so; once
      // the panel has left the row, one notice keeps it in sight.
      if (!shownHere(id)) noticeUnsaved(id);
      else if (!row) api.notifyError(error, "controlSheet.panel.saveFailed");
      return false;
    } finally {
      current.saving = false;
      savesOnTheWay.delete(id);
      if (subjectId.value !== id) forgetDraft(id);
      else if (!observationUnsaved(current)) {
        toast.remove(unsavedNoticeId(id));
      }
    }
  })();
  savesOnTheWay.set(id, run);
  return run;
}

function useTheirs(): void {
  if (!shownDraft.value) return;
  takeTheirObservations(shownDraft.value);
  if (subjectId.value) toast.remove(unsavedNoticeId(subjectId.value));
}

function keepMine(): void {
  if (!shownDraft.value) return;
  keepMyObservations(shownDraft.value);
  void saveObservations();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    void saveAll();
  }
}

// Closing the panel saves what waits; what cannot be saved (two versions to
// choose from, a failure) stays in its row, with its notice.
watch(open, (value) => {
  const id = subjectId.value;
  if (value || !id) return;
  if (conflict.value) noticeUnsaved(id);
  if (anyDirty.value) void saveAll();
});
// The panel open on a row shows its problems itself: no notice for it.
watch([open, subjectId], ([value, id]) => {
  if (value && id) toast.remove(unsavedNoticeId(id));
});
// Gone with the page (left after asking): its notices could open nothing.
onBeforeUnmount(() => {
  gone = true;
  for (const id of new Set([...drafts.keys(), ...draftPlaces.keys()])) {
    toast.remove(unsavedNoticeId(id));
  }
});
/**
 * Leaving the page saves every row's observations that wait, and asks
 * before losing those that could not be saved; staying opens the first of
 * them again. The saves are waited for LEAVE_SAVE_WAIT_MS at most: on a
 * connection that hangs, what is still saving counts as unsaved and the
 * question comes at once. Closing the tab asks first.
 */
onBeforeRouteLeave(async () => {
  await settledWithin(
    Promise.all([
      ...unsavedObservationIds(drafts).map((id) => saveObservations(id)),
      positionDirty.value
        ? (positionAnswer.value?.save() ?? Promise.resolve(true))
        : Promise.resolve(true),
    ]),
    LEAVE_SAVE_WAIT_MS,
  );
  const left = unsavedObservationIds(drafts);
  if (left.length === 0) return true;
  if (window.confirm(t("controlSheet.panel.leaveUnsaved"))) return true;
  const place = draftPlaces.get(left[0]!);
  if (place) emit("reopen", place.target);
  return false;
});
if (import.meta.client) {
  useEventListener(window, "beforeunload", (event: BeforeUnloadEvent) => {
    if (anyDirty.value || unsavedObservationIds(drafts).length > 0) {
      event.preventDefault();
    }
  });
}

/**
 * «Guardar» shows only while something waits to be saved, or is saving
 * (user's decision of 2026-11-19); never while two versions of the
 * observations are shown and nothing else is unsaved: the warning has its
 * own buttons.
 */
const showSave = computed(
  () =>
    (props.can.edit || Boolean(positionAnswer.value?.editable)) &&
    (anyDirty.value || anySaving.value) &&
    !(conflict.value !== null && !positionDirty.value),
);

const status = computed(() => {
  if (anySaving.value) return t("controlSheet.panel.saving");
  if (anyDirty.value) return t("controlSheet.panel.unsaved");
  if (savedAt.value) return t("controlSheet.panel.saved");
  return "";
});

// Other fields ---------------------------------------------------------------

const busy = ref<string | null>(null);

async function saveField(
  key: string,
  body: ControlSheetItemBody | ControlSheetAmendmentBody,
): Promise<boolean> {
  if (!url.value || !props.target || busy.value) return false;
  const kind = props.target.kind;
  busy.value = key;
  try {
    applySaved(kind, await patch(url.value, body));
    if (historyOpen.value) void loadHistory();
    return true;
  } catch (error) {
    const row = staleSheetRow<SheetRow>(error);
    if (row) {
      applySaved(kind, row);
      toast.add({
        title: t("controlSheet.panel.stale"),
        color: "warning",
        icon: "i-lucide-refresh-ccw",
      });
    } else {
      api.notifyError(error, "controlSheet.panel.saveFailed");
    }
    return false;
  } finally {
    busy.value = null;
  }
}

const itemRow = computed(() =>
  props.target?.kind === "item" ? (props.target.row.sheet ?? null) : null,
);

const NONE = "none";

/**
 * A «Retirado» by hand is for items without documents only; while the item
 * waits for a vote, neither «Retirado» nor «Decaído» (its vote treats it),
 * though one noted before stays shown so it can be taken away.
 */
const awaitingVote = computed(
  () => props.target?.kind === "item" && props.target.row.awaitingVote,
);
const resultItems = computed(() => {
  const withDocuments =
    props.target?.kind === "item" && props.target.row.documents.length > 0;
  const current = itemRow.value?.manualResult ?? null;
  return [
    { value: NONE, label: t("controlSheet.manualResult.none") },
    ...CONTROL_SHEET_MANUAL_RESULTS.filter(
      (value) =>
        value === current ||
        (!(withDocuments && value === "withdrawn") &&
          !(awaitingVote.value && value !== "not_applicable")),
    ).map((value) => ({
      value,
      label: t(`controlSheet.manualResult.${value}`),
    })),
  ];
});
const manualResult = computed<string>({
  get: () => itemRow.value?.manualResult ?? NONE,
  set: (value) => {
    const next = value === NONE ? null : (value as ControlSheetManualResult);
    if (next === (itemRow.value?.manualResult ?? null)) return;
    void saveField("result", {
      result: {
        value: next,
        updatedAt: itemRow.value?.resultUpdatedAt ?? null,
      },
    });
  },
});

/** The same box as the lists' (-model.ts), with its lock and token. */
const treatedControl = computed<TreatedControl | null>(() => {
  const target = props.target;
  if (!target) return null;
  return target.kind === "item"
    ? itemTreatedControl(target.row)
    : amendmentTreatedControl(target.row);
});
const autoTreated = computed(() => treatedControl.value?.lock === "auto");
/** Only its vote (an item) or the Mesa's decision (an amendment) treats it. */
const treatedByVote = computed(() => treatedControl.value?.lock === "vote");
/** An item a «Retirado» or «Decaído» by hand counts as treated. */
const treatedByResult = computed(() => treatedControl.value?.lock === "result");
const treatedMark = computed(() => sheetRow.value?.treated ?? null);
const treatedLocked = computed(() => Boolean(treatedControl.value?.lock));
const treated = computed<boolean>({
  get: () => props.treatedPending ?? treatedControl.value?.treated ?? false,
  set: (value) => {
    const control = treatedControl.value;
    if (!control || control.lock || props.treatedPending !== undefined) return;
    emit("treated", value);
  },
});
// A change to the row, whoever made it (the mark, the observations, the
// result, `listed`): the open history shows it.
watch(
  () => {
    const row = sheetRow.value;
    if (!row) return "";
    const item = "agendaItemId" in row ? row : null;
    return [
      treatedControl.value?.token,
      row.observationsUpdatedAt,
      item?.resultUpdatedAt,
      item?.listedUpdatedAt,
    ].join("|");
  },
  (key, previous) => {
    if (key !== previous && historyOpen.value) void loadHistory();
  },
);

const canWriteResult = computed(() => props.can.moderate);
/**
 * Taking an item added by hand off the sheet; not while «Se vota el punto»
 * or a vote on it in force keeps it there anyway.
 */
const showUnlist = computed(
  () =>
    props.target?.kind === "item" &&
    props.target.row.documents.length === 0 &&
    !props.target.row.ownListed &&
    itemRow.value?.listed === true &&
    props.can.edit,
);

async function unlist(): Promise<void> {
  // What could not be saved stays in sight, with the row still listed.
  if (dirty.value && !(await saveObservations())) return;
  const done = await saveField("listed", {
    listed: {
      value: false,
      updatedAt: itemRow.value?.listedUpdatedAt ?? null,
    },
  });
  // The item leaves the sheet: so does its panel.
  if (done) open.value = false;
}

// History --------------------------------------------------------------------

const historyOpen = ref(false);
const history = ref<ControlSheetHistoryDto | null>(null);
const historyLoading = ref(false);
const historyFailed = ref(false);

async function loadHistory(): Promise<void> {
  const rowId = sheetRow.value?.id;
  if (!rowId) {
    history.value = { entries: [] };
    return;
  }
  historyLoading.value = true;
  historyFailed.value = false;
  try {
    history.value = await api.get<ControlSheetHistoryDto>(
      `${props.apiBase}/control-sheet/history`,
      { row: rowId },
    );
  } catch {
    historyFailed.value = true;
  } finally {
    historyLoading.value = false;
  }
}

function toggleHistory(): void {
  historyOpen.value = !historyOpen.value;
  if (historyOpen.value) void loadHistory();
}

function restore(text: string): void {
  draft.value = text;
  toast.add({
    title: t("controlSheet.panel.restored"),
    icon: "i-lucide-undo-2",
  });
}

function historyDetail(
  entry: ControlSheetHistoryDto["entries"][number],
): string {
  const word = (value: boolean) => t(value ? "common.yes" : "common.no");
  if (entry.result) {
    const label = (value: ControlSheetManualResult | null) =>
      value
        ? t(`controlSheet.manualResult.${value}`)
        : t("controlSheet.manualResult.none");
    return t("controlSheet.panel.change", {
      from: label(entry.result.from),
      to: label(entry.result.to),
    });
  }
  if (entry.treated !== undefined) return word(entry.treated);
  if (entry.listed !== undefined) return word(entry.listed);
  return "";
}
</script>

<template>
  <USlideover
    v-model:open="open"
    side="right"
    :title="title"
    :description="
      target?.kind === 'amendment'
        ? t('controlSheet.panel.amendmentTitle')
        : t('controlSheet.panel.itemTitle')
    "
    :ui="{ content: 'max-w-full sm:max-w-lg', body: 'p-4 sm:p-5' }"
  >
    <template #body>
      <div v-if="target" class="flex flex-col gap-6">
        <p
          v-if="can.internal && !can.edit && !can.moderate"
          class="text-muted text-sm"
        >
          {{ t("controlSheet.panel.readOnly") }}
        </p>

        <!-- Treated -->
        <div v-if="can.internal" class="space-y-1">
          <USwitch
            v-model="treated"
            :label="
              target.kind === 'amendment'
                ? t('controlSheet.panel.treatedAmendment')
                : t('controlSheet.panel.treated')
            "
            :disabled="!can.moderate || treatedLocked || busy !== null"
            :aria-busy="treatedPending !== undefined || undefined"
          />
          <p class="text-muted text-xs">
            <template v-if="autoTreated">
              {{
                target.kind === "amendment"
                  ? t("controlSheet.panel.treatedAutoAmendment")
                  : t("controlSheet.panel.treatedAuto")
              }}
            </template>
            <template v-else-if="treatedByVote">
              {{
                target.kind === "amendment"
                  ? t("controlSheet.panel.treatedUndecided")
                  : t("controlSheet.panel.treatedAwaitingVote")
              }}
            </template>
            <template v-else-if="treatedByResult">
              {{ t("controlSheet.panel.treatedByResult") }}
            </template>
            <template v-else-if="treatedMark">
              {{
                treatedMark.by
                  ? t("controlSheet.panel.treatedBy", {
                      name: treatedMark.by,
                      when: when(treatedMark),
                    })
                  : t("controlSheet.panel.treatedByNoName", {
                      when: when(treatedMark),
                    })
              }}
            </template>
            <template v-else-if="!can.moderate">
              {{ t("controlSheet.panel.moderateOnly") }}
            </template>
            <template v-else>{{
              t("controlSheet.panel.treatedHint")
            }}</template>
          </p>
        </div>

        <!-- The amendment's result, recorded without projecting -->
        <ControlSheetAmendmentResult
          v-if="target.kind === 'amendment' && results?.record"
          :amendment="target.row.amendment"
          :amendments="results.amendments"
          :document="document ?? null"
          :final-voted="results.finalVoted"
          :api-base="apiBase"
          :context="voteContext"
          :code="target.code"
          @changed="(outcome) => emit('resultChanged', outcome)"
        />

        <!-- The presenter's answer to the amendment -->
        <ControlSheetPositionAnswer
          v-if="target.kind === 'amendment'"
          ref="positionAnswer"
          :row="target.row"
          :document="document ?? null"
          :api-base="apiBase"
          @saved="(amendment) => emit('positionSaved', amendment)"
        />

        <!-- Votes on the item -->
        <ControlSheetItemVotes
          v-if="target.kind === 'item'"
          :row="target.row"
          :api-base="apiBase"
          :can-write="can.edit || can.moderate"
          :context="voteContext"
          @changed="(vote) => emit('voteChanged', vote)"
        />

        <!-- The final votes of its documents, recorded without projecting -->
        <ControlSheetFinalVotes
          v-if="target.kind === 'item' && results?.record"
          :documents="target.row.documents"
          :api-base="apiBase"
          :context="voteContext"
          @changed="emit('resultChanged', null)"
        />

        <!-- Result by hand (items) -->
        <UFormField
          v-if="target.kind === 'item' && can.internal"
          :label="t('controlSheet.manualResult.label')"
          :description="
            target.row.outcome.byVote
              ? t('controlSheet.manualResult.byVote')
              : !can.moderate
                ? t('controlSheet.panel.resultMesaOnly')
                : target.row.awaitingVote
                  ? t('controlSheet.manualResult.awaitingVote')
                  : t('controlSheet.manualResult.hint')
          "
        >
          <USelect
            v-model="manualResult"
            :items="resultItems"
            value-key="value"
            :disabled="
              !canWriteResult || target.row.outcome.byVote || busy !== null
            "
            class="w-full sm:w-64"
          />
        </UFormField>

        <!-- Who spoke: each once, noted by whoever notes the speakers -->
        <section
          v-if="can.internal"
          class="space-y-2"
          aria-labelledby="control-sheet-speakers"
        >
          <h3
            id="control-sheet-speakers"
            class="text-highlighted text-sm font-medium"
          >
            {{ t("controlSheet.columns.speakers") }}
          </h3>
          <SpeakerNotesEditor
            v-if="speakers?.note"
            :agenda-item-id="target.kind === 'item' ? target.row.id : null"
            :amendment-id="
              target.kind === 'amendment' ? target.row.amendment.id : null
            "
            :turns="speakerTurns ?? []"
            :writable="speakers.open"
            @updated="(turns) => emit('speakersUpdated', turns)"
          />
          <ControlSheetSpeakers v-else :speakers="target.row.speakers" />
        </section>

        <!-- Observations -->
        <div v-if="can.internal" class="space-y-2">
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <label
              for="control-sheet-observations"
              class="text-highlighted text-sm font-medium"
            >
              {{ t("controlSheet.panel.observations") }}
            </label>
            <span class="text-muted text-xs" role="status" aria-live="polite">{{
              status
            }}</span>
          </div>
          <p id="control-sheet-observations-hint" class="text-muted text-xs">
            {{ t("controlSheet.panel.observationsHint") }}
            <template v-if="can.edit"
              >{{ t("controlSheet.panel.shortcut") }}.</template
            >
          </p>

          <UAlert
            v-if="conflict"
            color="warning"
            variant="subtle"
            icon="i-lucide-users"
            :title="
              conflict.name
                ? t('controlSheet.panel.conflictTitle', { name: conflict.name })
                : t('controlSheet.panel.conflictNoName')
            "
          >
            <template #description>
              <p class="text-muted mt-1 text-xs">
                {{ t("controlSheet.panel.conflictTheirs") }}
              </p>
              <p class="text-default mt-1 text-sm whitespace-pre-line">
                {{ conflict.text || t("controlSheet.panel.emptyText") }}
              </p>
              <div class="mt-3 flex flex-wrap gap-2">
                <UButton
                  size="sm"
                  color="neutral"
                  variant="outline"
                  :label="t('controlSheet.panel.conflictUseTheirs')"
                  @click="useTheirs"
                />
                <UButton
                  size="sm"
                  color="warning"
                  :label="t('controlSheet.panel.conflictKeepMine')"
                  @click="keepMine"
                />
              </div>
            </template>
          </UAlert>

          <UTextarea
            id="control-sheet-observations"
            v-model="draft"
            :aria-label="t('controlSheet.panel.observations')"
            aria-describedby="control-sheet-observations-hint"
            :placeholder="t('controlSheet.panel.placeholder')"
            :maxlength="CONTROL_SHEET_OBSERVATIONS_MAX_LENGTH"
            :disabled="!can.edit"
            :rows="5"
            autoresize
            class="w-full"
            @keydown="onKeydown"
            @blur="() => saveObservations()"
          />
          <!-- Its height kept, so the button showing never moves the panel. -->
          <div
            class="flex min-h-8 flex-wrap items-center justify-between gap-2"
          >
            <p class="text-muted text-xs">
              {{ editedLine(sheetRow?.observationsEdited ?? null) }}
            </p>
            <!-- The panel's one save: the observations and the answer, only
                 while something is unsaved (or saving: a click blurs the
                 field first, which starts the save). -->
            <UButton
              v-if="showSave"
              size="sm"
              icon="i-lucide-save"
              :label="t('controlSheet.panel.save')"
              :loading="anySaving"
              @click="saveAll"
            />
          </div>
        </div>
        <!-- Without the observations, the answer keeps its own save. -->
        <div
          v-else-if="positionAnswer?.editable"
          class="flex min-h-8 justify-end"
        >
          <UButton
            v-if="anyDirty || anySaving"
            size="sm"
            icon="i-lucide-save"
            :label="t('controlSheet.panel.save')"
            :loading="anySaving"
            @click="saveAll"
          />
        </div>

        <!-- Listed by hand -->
        <div v-if="showUnlist && can.internal" class="space-y-1">
          <p class="text-muted text-xs">
            {{ t("controlSheet.panel.listedHint") }}
          </p>
          <UButton
            size="sm"
            color="neutral"
            variant="outline"
            icon="i-lucide-list-x"
            :label="t('controlSheet.panel.unlist')"
            :loading="busy === 'listed'"
            @click="unlist"
          />
        </div>

        <!-- History -->
        <div v-if="can.internal" class="border-default space-y-3 border-t pt-4">
          <UButton
            size="sm"
            color="neutral"
            variant="ghost"
            :icon="historyOpen ? 'i-lucide-chevron-up' : 'i-lucide-history'"
            :label="
              historyOpen
                ? t('controlSheet.panel.hideHistory')
                : t('controlSheet.panel.showHistory')
            "
            :aria-expanded="historyOpen"
            @click="toggleHistory"
          />
          <template v-if="historyOpen">
            <div v-if="historyLoading && !history" role="status">
              <USkeleton class="h-12 w-full" aria-hidden="true" />
            </div>
            <p v-else-if="historyFailed" class="text-muted text-sm">
              {{ t("controlSheet.panel.historyFailed") }}
            </p>
            <p
              v-else-if="history && history.entries.length === 0"
              class="text-muted text-sm"
            >
              {{ t("controlSheet.panel.historyEmpty") }}
            </p>
            <ol v-else-if="history" class="space-y-3">
              <li
                v-for="entry in history.entries"
                :key="entry.id"
                class="border-default rounded-md border p-3 text-sm"
              >
                <p class="text-highlighted font-medium">
                  {{ t(`controlSheet.panel.events.${entry.type}`) }}
                  <span
                    v-if="historyDetail(entry)"
                    class="text-muted font-normal"
                  >
                    · {{ historyDetail(entry) }}
                  </span>
                </p>
                <p class="text-muted text-xs">
                  {{ entry.actorName ?? "" }}
                  <template v-if="entry.actorName">·</template>
                  {{ formatMoment(entry.at, { locale }).text }}
                  <template v-if="entry.impersonatedBy">
                    ·
                    {{
                      t("controlSheet.panel.impersonated", {
                        admin: entry.impersonatedBy.name,
                      })
                    }}
                  </template>
                </p>
                <template v-if="entry.text !== undefined">
                  <p class="text-default mt-2 whitespace-pre-line">
                    {{ entry.text || t("controlSheet.panel.emptyText") }}
                  </p>
                  <UButton
                    v-if="can.edit && entry.text !== draft"
                    size="xs"
                    color="neutral"
                    variant="link"
                    class="mt-1 px-0"
                    icon="i-lucide-undo-2"
                    :label="t('controlSheet.panel.restore')"
                    @click="restore(entry.text ?? '')"
                  />
                </template>
              </li>
            </ol>
          </template>
        </div>
      </div>
    </template>
  </USlideover>
</template>
