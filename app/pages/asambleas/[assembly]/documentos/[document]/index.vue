<script setup lang="ts">
import type { AmendmentDto } from "~~/shared/types/api";
import { consolidate } from "~~/shared/utils/content/consolidate";
import { touchedBlockIds, validateOps } from "~~/shared/utils/content/ops";
import { blockLabels } from "~~/shared/utils/content/render";
import {
  consolidationInputs,
  contiguousBlockRange,
  extendBlockSelection,
  type AmendmentComposerMode,
  type BlockSelection,
} from "~/composables/amendment/workspace";

/**
 * Document workspace (inside the assembly hub): the text on the left with
 * four views (original with gutter markers, one amendment over the full
 * text, live consolidation with provenance, side by side), and the
 * amendments on the right, grouped by the passage they act on. Selecting
 * blocks opens the composer in place of the list. On narrow screens the two
 * panels stack behind a toggle and the amendment detail opens in a
 * slideover.
 */

interface TextViewHandle {
  getSelectedBlockIds: () => string[];
  scrollToBlock: (blockId: string) => void;
}

type TextMode = "original" | "amended" | "consolidated" | "compare";
type Pane = "text" | "amendments";
type ListTab = "all" | "mine";

interface ComposerState {
  key: number;
  mode: AmendmentComposerMode;
  selection: string[];
  appendParagraph: boolean;
  draftId: string | null;
}

const { t } = useI18n();
const { member } = useMe();
const workspace = useDocumentWorkspace();
const {
  assembly,
  document,
  base,
  amendments: list,
  amendmentsUrl,
  documentPath,
  pending,
  errorStatusCode,
  refreshAll,
} = workspace;

useHead({
  title: () => document.value?.title ?? t("workspace.title"),
});

const isDesktop = useMediaQuery("(min-width: 1024px)");
const textView = useTemplateRef<TextViewHandle>("textView");

// Document state ----------------------------------------------------------------

const isStructured = computed(() => document.value?.format === "structured");
const isPublished = computed(
  () => Boolean(document.value?.baseVersion) && base.value.length > 0,
);
const canAmend = computed(
  () =>
    Boolean(document.value?.can.amend) &&
    isPublished.value &&
    !document.value?.finalVote,
);
const finalText = computed(
  () => document.value?.consolidatedVersion?.blocks ?? null,
);
const labels = computed(() => blockLabels(base.value));

function blockReference(blockId: string | null | undefined): string | null {
  if (!blockId) return null;
  const label = labels.value.get(blockId);
  if (!label) return null;
  const paragraph =
    label.paragraph > 0
      ? t("amendment.detail.paragraph", { n: label.paragraph })
      : null;
  return [label.heading, paragraph].filter(Boolean).join(" · ") || null;
}

// Panels ------------------------------------------------------------------------

const mobilePane = ref<Pane>("text");
const listTab = ref<ListTab>("all");
const textMode = ref<TextMode>("original");
const includeAccepted = ref(false);

const paneItems = computed(() => [
  {
    label: t("workspace.panes.text"),
    value: "text",
    icon: "i-lucide-file-text",
  },
  {
    label: t("workspace.panes.amendments"),
    value: "amendments",
    icon: "i-lucide-list-checks",
    badge:
      list.listed.value.length > 0
        ? String(list.listed.value.length)
        : undefined,
  },
]);

const modeItems = computed(() => [
  {
    label: t("workspace.modes.original"),
    value: "original",
    icon: "i-lucide-file-text",
  },
  {
    label: t("workspace.modes.amended"),
    value: "amended",
    icon: "i-lucide-file-diff",
  },
  {
    label: t("workspace.modes.consolidated"),
    value: "consolidated",
    icon: "i-lucide-file-check",
  },
  {
    label: t("workspace.modes.compare"),
    value: "compare",
    icon: "i-lucide-columns-2",
  },
]);

const listTabItems = computed(() => [
  {
    label: t("workspace.tabs.all"),
    value: "all",
    badge: String(list.listed.value.length),
  },
  {
    label: t("workspace.tabs.mine"),
    value: "mine",
    badge:
      list.drafts.value.length > 0
        ? String(list.drafts.value.length)
        : undefined,
  },
]);
const showMineTab = computed(
  () => canAmend.value || list.drafts.value.length > 0,
);

const panelUi = {
  root: "min-h-0 lg:min-h-0",
  body: "gap-4 p-4 sm:p-5 overflow-visible lg:overflow-y-auto",
};

// Selection and composer -------------------------------------------------------------

const selection = ref<BlockSelection>({ ids: [], anchor: null });
const composer = ref<ComposerState | null>(null);
let composerSeq = 0;

const composerDraft = computed(() =>
  composer.value?.draftId
    ? (list.byId.value.get(composer.value.draftId) ?? null)
    : null,
);
const composing = computed(() => composer.value !== null);
const canSelect = computed(
  () => canAmend.value && textMode.value === "original" && !composing.value,
);

function clearSelection(): void {
  selection.value = { ids: [], anchor: null };
}

function onBlockClick(
  blockId: string,
  event: MouseEvent | KeyboardEvent,
): void {
  if (!canSelect.value) return;
  selection.value = extendBlockSelection(
    base.value,
    selection.value,
    blockId,
    event.shiftKey,
  );
}

/** A text selection (drag) inside the original text selects its blocks. */
function onTextPointerUp(): void {
  if (!canSelect.value) return;
  const ids = textView.value?.getSelectedBlockIds() ?? [];
  if (ids.length === 0) return;
  const range = contiguousBlockRange(base.value, ids);
  selection.value = { ids: range, anchor: range[0] ?? null };
}

function openComposer(options: Partial<Omit<ComposerState, "key">>): void {
  composer.value = {
    key: (composerSeq += 1),
    mode: "passage",
    selection: [],
    appendParagraph: false,
    draftId: null,
    ...options,
  };
  detailOpen.value = false;
  textMode.value = "original";
  mobilePane.value = "amendments";
}

function amendSelection(
  mode: AmendmentComposerMode = "passage",
  appendParagraph = false,
): void {
  if (selection.value.ids.length === 0) return;
  openComposer({ mode, selection: [...selection.value.ids], appendParagraph });
}

function closeComposer(): void {
  composer.value = null;
}

function onComposerSaved(amendment: AmendmentDto): void {
  list.upsert(amendment);
  if (composer.value) composer.value.draftId = amendment.id;
}

function onComposerSubmitted(amendment: AmendmentDto): void {
  list.upsert(amendment);
  composer.value = null;
  clearSelection();
  listTab.value = "all";
  selectAmendment(amendment.id);
}

const newAmendmentItems = computed(() => [
  [
    {
      label: t("workspace.newMenu.selection"),
      icon: "i-lucide-text-cursor-input",
      disabled: selection.value.ids.length === 0,
      onSelect: () => amendSelection("passage"),
    },
    {
      label: t("workspace.newMenu.global"),
      icon: "i-lucide-replace-all",
      onSelect: () => openComposer({ mode: "global" }),
    },
  ],
  [
    {
      label: t("workspace.newMenu.return"),
      icon: "i-lucide-file-x",
      onSelect: () => openComposer({ mode: "return" }),
    },
    {
      label: t("workspace.newMenu.alternative"),
      icon: "i-lucide-file-pen-line",
      onSelect: () => openComposer({ mode: "alternative" }),
    },
  ],
]);

const selectionReference = computed(() =>
  blockReference(selection.value.ids[0]),
);

// Amendment detail -----------------------------------------------------------------

const selectedId = ref<string | null>(null);
const detailOpen = ref(false);

const selectedAmendment = computed(() =>
  selectedId.value ? (list.byId.value.get(selectedId.value) ?? null) : null,
);

function scrollToAmendment(amendment: AmendmentDto): void {
  const first = touchedBlockIds(amendment.ops)[0];
  if (!first) return;
  void nextTick(() => textView.value?.scrollToBlock(first));
}

function selectAmendment(
  id: string,
  options: { fromText?: boolean } = {},
): void {
  selectedId.value = id;
  if (composing.value) return;
  detailOpen.value = true;
  const amendment = list.byId.value.get(id);
  if (!options.fromText && textMode.value === "original") {
    textMode.value = "amended";
  }
  if (amendment && !options.fromText && isDesktop.value) {
    scrollToAmendment(amendment);
  }
}

function closeDetail(): void {
  detailOpen.value = false;
}

function onDetailRemoved(id: string): void {
  list.remove(id);
  if (selectedId.value === id) selectedId.value = null;
  detailOpen.value = false;
}

function onDetailEdit(amendment: AmendmentDto): void {
  openComposer({ draftId: amendment.id });
}

const showDesktopDetail = computed(
  () =>
    isDesktop.value &&
    detailOpen.value &&
    !composing.value &&
    selectedAmendment.value !== null,
);
const mobileDetailOpen = computed({
  get: () =>
    !isDesktop.value &&
    detailOpen.value &&
    !composing.value &&
    selectedAmendment.value !== null,
  set: (open: boolean) => {
    if (!open) detailOpen.value = false;
  },
});

const relationCandidates = computed(() =>
  list.listed.value.filter((amendment) => amendment.id !== selectedId.value),
);

function onMarkerClick(blockId: string): void {
  list.filters.value = { ...list.filters.value, blockId };
  listTab.value = "all";
  detailOpen.value = false;
  mobilePane.value = "amendments";
}

// Text views -----------------------------------------------------------------------

const amendedAnnotated = computed(() => {
  const amendment = selectedAmendment.value;
  if (!amendment || amendment.ops.length === 0 || base.value.length === 0) {
    return null;
  }
  if (validateOps(base.value, amendment.ops).length > 0) return null;
  return consolidate(base.value, [{ id: amendment.id, ops: amendment.ops }])
    .annotated;
});

const selectedOverlaps = computed(() =>
  selectedId.value ? (list.overlaps.value.get(selectedId.value) ?? []) : [],
);

const overlapBlockIds = computed(() => {
  const amendment = selectedAmendment.value;
  if (!amendment) return [];
  const own = new Set(touchedBlockIds(amendment.ops));
  const ids = new Set<string>();
  for (const overlap of selectedOverlaps.value) {
    const other = list.byId.value.get(overlap.id);
    if (!other) continue;
    for (const id of touchedBlockIds(other.ops)) {
      if (own.has(id)) ids.add(id);
    }
  }
  return [...ids];
});

const consolidation = computed(() =>
  base.value.length > 0
    ? consolidate(
        base.value,
        consolidationInputs(
          list.amendments.value,
          includeAccepted.value && !finalText.value,
        ),
      )
    : null,
);
const compareBlocks = computed(
  () => finalText.value ?? consolidation.value?.blocks ?? [],
);
const showAcceptedToggle = computed(
  () => !finalText.value && Boolean(document.value?.positionsVisible),
);

const originalSelected = computed(() =>
  composer.value &&
  (composer.value.mode === "passage" || composer.value.mode === "delete")
    ? contiguousBlockRange(base.value, composer.value.selection)
    : selection.value.ids,
);

const fallbackText = computed(
  () => document.value?.workingVersion?.blocks ?? null,
);

// Live list announcement --------------------------------------------------------------

const listAnnouncement = computed(() =>
  list.pending.value
    ? ""
    : t(
        "amendment.list.count",
        { count: list.filtered.value.length },
        list.filtered.value.length,
      ),
);

const filteredBlockLabel = computed(() =>
  blockReference(list.filters.value.blockId),
);
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- Loading -->
    <div
      v-if="pending"
      class="flex flex-col gap-4"
      aria-busy="true"
      :aria-label="t('workspace.loading')"
    >
      <USkeleton class="h-4 w-32" />
      <USkeleton class="h-8 w-3/4 max-w-xl" />
      <USkeleton class="h-12 w-full" />
      <div class="grid gap-4 lg:grid-cols-[3fr_2fr]">
        <USkeleton class="h-[28rem] w-full" />
        <USkeleton class="hidden h-[28rem] w-full lg:block" />
      </div>
    </div>

    <!-- Error -->
    <CommonEmptyState
      v-else-if="!document || !assembly"
      :icon="
        errorStatusCode === 404
          ? 'i-lucide-file-question'
          : 'i-lucide-cloud-off'
      "
      :title="
        errorStatusCode === 404
          ? t('workspace.notFound')
          : t('workspace.loadError')
      "
      :description="
        errorStatusCode === 404
          ? t('workspace.notFoundDescription')
          : t('workspace.loadErrorDescription')
      "
    >
      <template #action>
        <UButton
          v-if="errorStatusCode !== 404"
          icon="i-lucide-refresh-ccw"
          :label="t('workspace.retry')"
          @click="refreshAll"
        />
        <UButton
          :to="workspace.hub.sectionPath('documentos')"
          color="neutral"
          variant="outline"
          icon="i-lucide-arrow-left"
          :label="t('workspace.backToDocuments')"
        />
      </template>
    </CommonEmptyState>

    <template v-else>
      <DocumentHeader :document="document" :assembly="assembly">
        <UButton
          v-if="document.can.edit && document.status !== 'published'"
          :to="documentPath('editar')"
          icon="i-lucide-pencil"
          color="neutral"
          variant="outline"
          size="sm"
          :label="t('workspace.editDraft')"
        />
        <UButton
          v-if="isPublished"
          :to="documentPath('consolidado')"
          icon="i-lucide-file-check"
          color="neutral"
          variant="outline"
          size="sm"
          :label="t('workspace.consolidatedPage')"
        />
        <ExportButton
          v-if="isStructured && isPublished"
          :assembly="assembly.id"
          :document="document.id"
          variant="clean"
        />
        <UButton
          v-if="document.format === 'file' && document.fileUrl"
          :to="document.fileUrl"
          external
          target="_blank"
          icon="i-lucide-file-text"
          size="sm"
          :label="t('workspace.text.openPdf')"
        />
      </DocumentHeader>

      <p
        v-if="document.summary"
        class="text-muted max-w-3xl text-sm whitespace-pre-line"
      >
        {{ document.summary }}
      </p>

      <AmendmentWindowBanner :document="document" />

      <!-- Uploaded PDF -->
      <CommonEmptyState
        v-if="document.format === 'file'"
        icon="i-lucide-file-text"
        :title="t('workspace.text.file')"
        :description="t('workspace.text.fileDescription')"
        variant="outline"
      >
        <template v-if="document.fileUrl" #action>
          <UButton
            :to="document.fileUrl"
            external
            target="_blank"
            icon="i-lucide-external-link"
            :label="t('workspace.text.openPdf')"
          />
        </template>
      </CommonEmptyState>

      <!-- Not published yet -->
      <template v-else-if="!isPublished">
        <UAlert
          color="info"
          variant="subtle"
          icon="i-lucide-info"
          :title="t('workspace.text.unpublished')"
          :description="t('workspace.text.unpublishedDescription')"
        />
        <div
          v-if="fallbackText && fallbackText.length > 0"
          class="border-default rounded-lg border p-4 sm:p-6"
        >
          <ContentView :blocks="fallbackText" />
        </div>
        <CommonEmptyState
          v-else
          icon="i-lucide-file-clock"
          :title="t('workspace.text.empty')"
          variant="outline"
        />
      </template>

      <!-- Workspace -->
      <template v-else>
        <UTabs
          v-model="mobilePane"
          :items="paneItems"
          :content="false"
          size="sm"
          class="lg:hidden"
          :aria-label="t('workspace.panes.label')"
        />

        <div
          class="border-default flex flex-col overflow-hidden rounded-lg border lg:h-[calc(100svh-3rem)] lg:min-h-[32rem] lg:flex-row"
        >
          <!-- Text -->
          <UDashboardPanel
            id="document-workspace-text"
            resizable
            :default-size="58"
            :min-size="35"
            :max-size="72"
            :class="mobilePane === 'text' ? 'flex' : 'hidden lg:flex'"
            :ui="panelUi"
          >
            <template #header>
              <UDashboardToolbar
                :ui="{
                  root: 'flex-wrap gap-2 py-2 min-h-12 h-auto',
                  left: 'flex-wrap',
                  right: 'flex-wrap',
                }"
              >
                <template #left>
                  <UTabs
                    v-model="textMode"
                    :items="modeItems"
                    :content="false"
                    variant="pill"
                    size="xs"
                    :aria-label="t('workspace.modes.label')"
                  />
                </template>
                <template #right>
                  <USwitch
                    v-if="
                      (textMode === 'consolidated' || textMode === 'compare') &&
                      showAcceptedToggle
                    "
                    v-model="includeAccepted"
                    size="sm"
                    :label="t('workspace.includeAccepted')"
                  />
                </template>
              </UDashboardToolbar>
            </template>

            <template #body>
              <!-- Original -->
              <template v-if="textMode === 'original'">
                <div
                  v-if="canAmend && !composing"
                  class="border-default bg-default/95 sticky top-0 z-10 -mx-1 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 backdrop-blur"
                  role="region"
                  :aria-label="t('workspace.selection.label')"
                >
                  <template v-if="selection.ids.length > 0">
                    <span class="text-sm font-medium" aria-live="polite">
                      {{
                        t(
                          "workspace.selection.count",
                          { count: selection.ids.length },
                          selection.ids.length,
                        )
                      }}
                      <span
                        v-if="selectionReference"
                        class="text-muted font-normal"
                      >
                        · {{ selectionReference }}
                      </span>
                    </span>
                    <span class="ms-auto flex flex-wrap items-center gap-1.5">
                      <UButton
                        icon="i-lucide-pencil-line"
                        size="xs"
                        :label="t('workspace.selection.amend')"
                        @click="amendSelection('passage')"
                      />
                      <UButton
                        icon="i-lucide-between-horizontal-end"
                        color="neutral"
                        variant="outline"
                        size="xs"
                        :label="t('workspace.selection.addAfter')"
                        @click="amendSelection('passage', true)"
                      />
                      <UButton
                        icon="i-lucide-trash-2"
                        color="neutral"
                        variant="outline"
                        size="xs"
                        :label="t('workspace.selection.delete')"
                        @click="amendSelection('delete')"
                      />
                      <UButton
                        icon="i-lucide-x"
                        color="neutral"
                        variant="ghost"
                        size="xs"
                        :aria-label="t('workspace.selection.clear')"
                        @click="clearSelection"
                      />
                    </span>
                  </template>
                  <p v-else class="text-muted text-sm">
                    <UIcon
                      name="i-lucide-mouse-pointer-click"
                      class="me-1 size-4 align-text-bottom"
                      aria-hidden="true"
                    />
                    {{ t("workspace.selection.hint") }}
                  </p>
                </div>

                <div @mouseup="onTextPointerUp" @keyup.shift="onTextPointerUp">
                  <ContentView
                    ref="textView"
                    :blocks="base"
                    :markers="list.markers.value"
                    :selected="originalSelected"
                    :interactive="canSelect"
                    @block-click="onBlockClick"
                    @marker-click="onMarkerClick"
                  />
                </div>
              </template>

              <!-- One amendment over the full text -->
              <template v-else-if="textMode === 'amended'">
                <CommonEmptyState
                  v-if="!selectedAmendment"
                  icon="i-lucide-mouse-pointer-click"
                  :title="t('workspace.amended.empty')"
                  :description="t('workspace.amended.emptyDescription')"
                  size="sm"
                />
                <template v-else>
                  <div class="flex flex-col gap-2">
                    <p class="text-sm">
                      {{
                        t("workspace.amended.showing", {
                          label: list.labelOf(selectedAmendment.id),
                        })
                      }}
                    </p>
                    <div
                      v-if="selectedOverlaps.length > 0"
                      class="flex flex-wrap items-center gap-1.5"
                    >
                      <span class="text-warning text-sm">
                        <UIcon
                          name="i-lucide-layers"
                          class="me-1 size-4 align-text-bottom"
                          aria-hidden="true"
                        />
                        {{ t("workspace.amended.overlaps") }}
                      </span>
                      <UButton
                        v-for="overlap in selectedOverlaps"
                        :key="overlap.id"
                        size="xs"
                        color="warning"
                        variant="soft"
                        :label="list.labelOf(overlap.id)"
                        @click="selectAmendment(overlap.id)"
                      />
                    </div>
                  </div>
                  <UAlert
                    v-if="selectedAmendment.kind === 'totality_return'"
                    color="neutral"
                    variant="subtle"
                    icon="i-lucide-file-x"
                    :title="t('amendment.kinds.totality_return')"
                    :description="t('amendment.detail.returnNote')"
                  />
                  <UAlert
                    v-else-if="!amendedAnnotated"
                    color="warning"
                    variant="subtle"
                    icon="i-lucide-triangle-alert"
                    :title="t('workspace.amended.invalid')"
                  />
                  <ContentView
                    v-if="amendedAnnotated"
                    ref="textView"
                    :annotated="amendedAnnotated"
                    mode="diff"
                    :focus="selectedAmendment.id"
                    :selected="overlapBlockIds"
                  />
                </template>
              </template>

              <!-- Live consolidation -->
              <template
                v-else-if="textMode === 'consolidated' && consolidation"
              >
                <UAlert
                  v-if="finalText"
                  color="success"
                  variant="subtle"
                  icon="i-lucide-badge-check"
                  :title="t('workspace.consolidated.final')"
                />
                <UAlert
                  v-else-if="consolidation.applied.length === 0"
                  color="neutral"
                  variant="subtle"
                  icon="i-lucide-info"
                  :title="t('workspace.consolidated.none')"
                />
                <p v-else class="text-muted text-sm">
                  {{
                    t(
                      "workspace.consolidated.applied",
                      { count: consolidation.applied.length },
                      consolidation.applied.length,
                    )
                  }}
                </p>
                <UAlert
                  v-if="consolidation.conflicts.length > 0"
                  color="warning"
                  variant="subtle"
                  icon="i-lucide-triangle-alert"
                  :title="t('workspace.consolidated.conflicts')"
                >
                  <template #description>
                    <ul class="list-disc ps-5">
                      <li
                        v-for="conflict in consolidation.conflicts"
                        :key="conflict.amendmentId"
                      >
                        {{
                          conflict.conflictsWith.length > 0
                            ? t("workspace.consolidated.conflictWith", {
                                label: list.labelOf(conflict.amendmentId),
                                others: conflict.conflictsWith
                                  .map((id) => list.labelOf(id))
                                  .join(", "),
                              })
                            : t("workspace.consolidated.conflictInvalid", {
                                label: list.labelOf(conflict.amendmentId),
                              })
                        }}
                      </li>
                    </ul>
                  </template>
                </UAlert>
                <ContentView
                  ref="textView"
                  :annotated="consolidation.annotated"
                  mode="provenance"
                  :label="list.shortLabelOf"
                  :focus="selectedId"
                  interactive
                  @amendment-click="selectAmendment($event, { fromText: true })"
                />
              </template>

              <!-- Side by side -->
              <div v-else-if="textMode === 'compare'" class="@container">
                <div class="grid gap-6 @3xl:grid-cols-2">
                  <section class="min-w-0">
                    <h3
                      class="text-muted mb-3 text-xs font-semibold tracking-wide uppercase"
                    >
                      {{ t("workspace.compare.original") }}
                    </h3>
                    <ContentView :blocks="base" />
                  </section>
                  <section
                    class="border-default min-w-0 border-t pt-6 @3xl:border-t-0 @3xl:border-s @3xl:ps-6 @3xl:pt-0"
                  >
                    <h3
                      class="text-muted mb-3 text-xs font-semibold tracking-wide uppercase"
                    >
                      {{
                        finalText
                          ? t("workspace.compare.final")
                          : t("workspace.compare.consolidated")
                      }}
                    </h3>
                    <ContentView :blocks="compareBlocks" />
                  </section>
                </div>
              </div>
            </template>
          </UDashboardPanel>

          <!-- Amendments -->
          <UDashboardPanel
            id="document-workspace-amendments"
            :class="mobilePane === 'amendments' ? 'flex' : 'hidden lg:flex'"
            :ui="panelUi"
          >
            <template v-if="!composing && !showDesktopDetail" #header>
              <UDashboardToolbar
                :ui="{
                  root: 'flex-wrap gap-2 py-2 min-h-12 h-auto',
                  left: 'flex-wrap',
                  right: 'flex-wrap',
                }"
              >
                <template #left>
                  <UTabs
                    v-if="showMineTab"
                    v-model="listTab"
                    :items="listTabItems"
                    :content="false"
                    variant="link"
                    size="sm"
                    :aria-label="t('workspace.tabs.label')"
                  />
                  <h2 v-else class="text-highlighted text-sm font-semibold">
                    {{ t("workspace.tabs.all") }}
                  </h2>
                </template>
                <template #right>
                  <UDropdownMenu
                    v-if="canAmend"
                    :items="newAmendmentItems"
                    :content="{ align: 'end' }"
                  >
                    <UButton
                      icon="i-lucide-plus"
                      size="sm"
                      trailing-icon="i-lucide-chevron-down"
                      :label="t('workspace.newAmendment')"
                    />
                  </UDropdownMenu>
                </template>
              </UDashboardToolbar>
            </template>

            <template #body>
              <!-- Composer -->
              <AmendmentComposer
                v-if="composer"
                :key="composer.key"
                :base="base"
                :document="document"
                :amendments-url="amendmentsUrl"
                :mode="composer.mode"
                :selection="composer.selection"
                :append-paragraph="composer.appendParagraph"
                :draft="composerDraft"
                @close="closeComposer"
                @saved="onComposerSaved"
                @submitted="onComposerSubmitted"
                @conflict="refreshAll()"
              />

              <!-- Detail (wide screens) -->
              <AmendmentDetail
                v-else-if="showDesktopDetail && selectedAmendment"
                :amendment="selectedAmendment"
                :base="base"
                :document="document"
                :amendments-url="amendmentsUrl"
                :label-of="list.labelOf"
                :relations="list.relationsOf(selectedAmendment.id)"
                :candidates="relationCandidates"
                :overlaps="selectedOverlaps"
                @close="closeDetail"
                @select="selectAmendment"
                @edit="onDetailEdit"
                @updated="list.upsert"
                @removed="onDetailRemoved"
                @changed="refreshAll()"
              />

              <!-- My drafts -->
              <template v-else-if="listTab === 'mine' && showMineTab">
                <CommonEmptyState
                  v-if="list.drafts.value.length === 0"
                  icon="i-lucide-file-pen"
                  :title="t('workspace.mine.empty')"
                  :description="
                    canAmend ? t('workspace.mine.emptyDescription') : undefined
                  "
                  size="sm"
                />
                <ul v-else class="flex flex-col gap-2">
                  <li v-for="draft in list.drafts.value" :key="draft.id">
                    <AmendmentCard
                      :amendment="draft"
                      :label="list.labelOf(draft.id)"
                      :label-of="list.labelOf"
                      :selected="selectedId === draft.id"
                      @select="selectAmendment"
                    />
                  </li>
                </ul>
              </template>

              <!-- All amendments -->
              <template v-else>
                <AmendmentFilterBar
                  v-model="list.filters.value"
                  :author-options="list.authorOptions.value"
                  :can-filter-mine="Boolean(member)"
                  :block-label="filteredBlockLabel"
                />
                <p class="sr-only" aria-live="polite">{{ listAnnouncement }}</p>

                <div
                  v-if="
                    list.pending.value && list.amendments.value.length === 0
                  "
                  class="flex flex-col gap-3"
                  aria-busy="true"
                  :aria-label="t('amendment.list.loading')"
                >
                  <USkeleton v-for="i in 4" :key="i" class="h-24 w-full" />
                </div>

                <UAlert
                  v-else-if="
                    list.error.value && list.amendments.value.length === 0
                  "
                  color="error"
                  variant="subtle"
                  icon="i-lucide-circle-alert"
                  role="alert"
                  :title="t('amendment.list.error')"
                  :actions="[
                    {
                      label: t('amendment.actions.retry'),
                      icon: 'i-lucide-refresh-ccw',
                      color: 'neutral',
                      variant: 'outline',
                      onClick: () => {
                        void list.refresh();
                      },
                    },
                  ]"
                />

                <CommonEmptyState
                  v-else-if="list.listed.value.length === 0"
                  icon="i-lucide-message-square-dashed"
                  :title="t('amendment.list.empty')"
                  :description="
                    canAmend
                      ? t('amendment.list.emptyCanAmend')
                      : t('amendment.list.emptyDescription')
                  "
                  size="sm"
                />

                <CommonEmptyState
                  v-else-if="list.filtered.value.length === 0"
                  icon="i-lucide-filter-x"
                  :title="t('amendment.list.emptyFiltered')"
                  size="sm"
                >
                  <template #action>
                    <UButton
                      color="neutral"
                      variant="outline"
                      icon="i-lucide-filter-x"
                      :label="t('amendment.filters.clear')"
                      @click="list.resetFilters()"
                    />
                  </template>
                </CommonEmptyState>

                <AmendmentList
                  v-else
                  :groups="list.groups.value"
                  :selected-id="selectedId"
                  :label-of="list.labelOf"
                  :relations-of="list.relationsOf"
                  @select="selectAmendment"
                />
              </template>
            </template>
          </UDashboardPanel>
        </div>

        <!-- Detail (narrow screens) -->
        <USlideover
          v-model:open="mobileDetailOpen"
          side="right"
          :title="selectedAmendment ? list.labelOf(selectedAmendment.id) : ''"
          :description="t('workspace.detailDescription')"
          :ui="{ content: 'max-w-full sm:max-w-lg', body: 'p-4 sm:p-6' }"
        >
          <template #body>
            <AmendmentDetail
              v-if="selectedAmendment"
              :amendment="selectedAmendment"
              :base="base"
              :document="document"
              :amendments-url="amendmentsUrl"
              :label-of="list.labelOf"
              :relations="list.relationsOf(selectedAmendment.id)"
              :candidates="relationCandidates"
              :overlaps="selectedOverlaps"
              :closable="false"
              @select="selectAmendment"
              @edit="onDetailEdit"
              @updated="list.upsert"
              @removed="onDetailRemoved"
              @changed="refreshAll()"
            />
          </template>
        </USlideover>
      </template>
    </template>
  </div>
</template>
