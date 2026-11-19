<script setup lang="ts">
import {
  CONTROL_SHEET_MANUAL_RESULTS,
  type ControlSheetManualResult,
} from "~~/shared/constants/domain";
import type {
  AmendmentDto,
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
 * typing never replaces it.
 */

export type RowPanelTarget =
  | { kind: "item"; row: GeneralSheetRow }
  | { kind: "amendment"; row: AmendmentSheetRow; code: string };

const props = defineProps<{
  target: RowPanelTarget | null;
  apiBase: string;
  can: { edit: boolean; moderate: boolean };
  /** The treated mark on its way for this row. */
  treatedPending?: boolean;
  /** What the votes on an item depend on besides the row. */
  voteContext: ItemVoteContext;
  /** The document of an amendment's row: who answers it, and its rule. */
  document?: DocumentSummaryDto | null;
  /** Every turn that spoke in the assembly (ControlSheetDto.turns). */
  speakerTurns?: readonly SpeakingTurnDto[];
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
  /** Someone was noted as having spoken, or taken back. */
  speakersUpdated: [];
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

const title = computed(() => {
  const target = props.target;
  if (!target) return "";
  if (target.kind === "amendment") return target.code;
  return numberedAgendaTitle(
    target.row.number,
    target.row.title,
    t("agenda.unlisted.inText"),
  );
});

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

const draft = ref("");
/** The text and token the draft started from. */
const base = ref<{ text: string; token: string | null }>({
  text: "",
  token: null,
});
const saving = ref(false);
const savedAt = ref<number | null>(null);
const conflict = ref<{
  name: string | null;
  text: string;
  token: string | null;
} | null>(null);

const dirty = computed(() => draft.value.trim() !== base.value.text);

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

/** The one «Guardar»: the observations and the answer, whichever changed. */
async function saveAll(): Promise<void> {
  await Promise.all([
    dirty.value ? saveObservations() : Promise.resolve(),
    positionDirty.value ? positionAnswer.value?.save() : Promise.resolve(true),
  ]);
}

/** Takes the row's text and token as the start of the draft. */
function syncDraft(): void {
  const row = sheetRow.value;
  base.value = {
    text: row?.observations ?? "",
    token: row?.observationsUpdatedAt ?? null,
  };
  draft.value = base.value.text;
}

// Another row opened: start over. The panel losing its row for a moment
// (a refetch, the debate moving) keeps everything.
watch(subjectId, (id, previous) => {
  if (!id || id === previous) return;
  syncDraft();
  conflict.value = null;
  savedAt.value = null;
  history.value = null;
  historyOpen.value = false;
});
// A refetch brings someone else's text: take it unless the reader is typing.
watch(
  () => [sheetRow.value?.observationsUpdatedAt, sheetRow.value?.observations],
  () => {
    const token = sheetRow.value?.observationsUpdatedAt ?? null;
    if (dirty.value || saving.value || token === base.value.token) return;
    syncDraft();
    savedAt.value = null;
  },
);
syncDraft();

async function saveObservations(): Promise<void> {
  // While two versions are shown, only the reader's choice saves.
  if (conflict.value) return;
  if (!url.value || !props.target || !props.can.edit) return;
  if (saving.value || !dirty.value) return;
  const target = url.value;
  const kind = props.target.kind;
  const subject = subjectId.value;
  const sent = draft.value;
  const same = () => subjectId.value === subject;
  saving.value = true;
  try {
    const row = await patch(target, {
      observations: { value: sent, updatedAt: base.value.token },
    });
    applySaved(kind, row);
    if (!same()) return;
    base.value = { text: row.observations, token: row.observationsUpdatedAt };
    // What was typed while it saved stays in the draft.
    if (draft.value === sent) draft.value = row.observations;
    savedAt.value = Date.now();
    if (historyOpen.value) void loadHistory();
  } catch (error) {
    const row = staleSheetRow<SheetRow>(error);
    if (row) {
      applySaved(kind, row);
      if (same()) {
        conflict.value = {
          name: row.observationsEdited?.by ?? null,
          text: row.observations,
          token: row.observationsUpdatedAt,
        };
      }
    } else {
      api.notifyError(error, "controlSheet.panel.saveFailed");
    }
  } finally {
    saving.value = false;
  }
}

function useTheirs(): void {
  const theirs = conflict.value;
  if (!theirs) return;
  base.value = { text: theirs.text, token: theirs.token };
  draft.value = theirs.text;
  conflict.value = null;
}

function keepMine(): void {
  const theirs = conflict.value;
  if (!theirs) return;
  base.value = { text: theirs.text, token: theirs.token };
  conflict.value = null;
  void saveObservations();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    void saveAll();
  }
}

// Leaving with unsaved changes saves them (closing the panel, going to
// another page); closing the tab asks first.
watch(open, (value) => {
  if (!value && anyDirty.value) void saveAll();
});
onBeforeRouteLeave(() => {
  if (anyDirty.value) void saveAll();
});
if (import.meta.client) {
  useEventListener(window, "beforeunload", (event: BeforeUnloadEvent) => {
    if (anyDirty.value) event.preventDefault();
  });
}

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

/** A «Retirado» by hand is for items without documents only. */
const resultItems = computed(() => {
  const withDocuments =
    props.target?.kind === "item" && props.target.row.documents.length > 0;
  return [
    { value: NONE, label: t("controlSheet.manualResult.none") },
    ...CONTROL_SHEET_MANUAL_RESULTS.filter(
      (value) => !(withDocuments && value === "withdrawn"),
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
// A new mark, whoever set it: the open history shows it.
watch(
  () => treatedControl.value?.token,
  (token, previous) => {
    if (token !== previous && historyOpen.value) void loadHistory();
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
  if (dirty.value) await saveObservations();
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
        <p v-if="!can.edit && !can.moderate" class="text-muted text-sm">
          {{ t("controlSheet.panel.readOnly") }}
        </p>

        <!-- Treated -->
        <div class="space-y-1">
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

        <!-- Result by hand (items) -->
        <UFormField
          v-if="target.kind === 'item'"
          :label="t('controlSheet.manualResult.label')"
          :description="
            target.row.outcome.byVote
              ? t('controlSheet.manualResult.byVote')
              : can.moderate
                ? t('controlSheet.manualResult.hint')
                : t('controlSheet.panel.resultMesaOnly')
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
        <section class="space-y-2" aria-labelledby="control-sheet-speakers">
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
            @updated="emit('speakersUpdated')"
          />
          <ControlSheetSpeakers v-else :speakers="target.row.speakers" />
        </section>

        <!-- Observations -->
        <div class="space-y-2">
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
            @blur="saveObservations"
          />
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-muted text-xs">
              {{ editedLine(sheetRow?.observationsEdited ?? null) }}
            </p>
            <!-- The panel's one save: the observations and the answer. -->
            <UButton
              v-if="can.edit || positionAnswer?.editable"
              size="sm"
              icon="i-lucide-save"
              :label="t('controlSheet.panel.save')"
              :loading="anySaving"
              :disabled="!anyDirty || (conflict !== null && !positionDirty)"
              @click="saveAll"
            />
          </div>
        </div>

        <!-- Listed by hand -->
        <div v-if="showUnlist" class="space-y-1">
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
        <div class="border-default space-y-3 border-t pt-4">
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
