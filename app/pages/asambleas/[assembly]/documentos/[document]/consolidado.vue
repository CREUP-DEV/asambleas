<script setup lang="ts">
import type { AmendmentStatus } from "~~/shared/constants/domain";
import type { ConciliationBody, FormCorrectionsDto } from "~~/shared/types/api";
import type { AmendmentOp } from "~~/shared/types/content";
import {
  consolidateApproved,
  type Passage,
} from "~~/shared/utils/content/passages";
import { kindAcceptsFile } from "~~/shared/utils/documentFormat";
import { consolidationInputs } from "~/composables/amendment/workspace";
import {
  sameBlocks,
  usePendingConciliation,
} from "~/composables/document/pendingConciliation";
import type { WordingDialogContext } from "~/composables/document/wordingDialog";
import {
  contentPages,
  documentPagesTarget,
  useDocumentPages,
} from "~/composables/document/useDocumentPages";

/**
 * Consolidated text of a document (inside the assembly hub): the base with
 * every approved amendment applied, each amended fragment marked with its
 * amendment code. Clicking a fragment shows that amendment, its outcome and
 * its vote. Below come the final vote (when held) and an annex of every
 * decided amendment by outcome (outcomes no amendment had are left out).
 * Clean and annotated PDFs are exported from here.
 */

type Outcome = Extract<
  AmendmentStatus,
  | "approved"
  | "rejected"
  | "withdrawn"
  | "lapsed"
  | "transacted"
  | "inadmissible"
>;

const OUTCOMES: Outcome[] = [
  "approved",
  "rejected",
  "withdrawn",
  "lapsed",
  "transacted",
  "inadmissible",
];

const { t } = useI18n();
const workspace = useDocumentWorkspace();
const {
  assembly,
  document,
  base,
  amendments: list,
  documentPath,
  pending,
  errorStatusCode,
  refreshAll,
  refreshDocument,
} = workspace;

/** Base url of this document's API, by ids. */
const documentApi = computed(() =>
  assembly.value && document.value
    ? `/api/assemblies/${encodeURIComponent(assembly.value.id)}/documents/${encodeURIComponent(document.value.id)}`
    : "",
);
/** The editor of a correction of form is open (it shows the text itself). */
const correcting = ref(false);
const formCorrections = useTemplateRef<{
  start: (blockId?: string | null) => void;
  load: () => Promise<void>;
}>("formCorrections");
/**
 * Opens the correction editor at `blockId` (where the reader was), or at
 * its start: then the view goes to the corrections' heading, since nothing
 * else brings the editor into view.
 */
function startCorrection(blockId: string | null = null): void {
  formCorrections.value?.start(blockId);
  if (blockId) return;
  void nextTick(() =>
    globalThis.document
      ?.getElementById("form-corrections")
      ?.scrollIntoView({ block: "start" }),
  );
}

// Where the reader is in the text ------------------------------------------------
// «Corregir la forma» sits above the text: a reader who saw an erratum on
// page 23 goes back up to press it, so the editor opens at the last block
// they rested on (as «Presentar enmienda» does on the document's page).

const textRoot = useTemplateRef<HTMLElement>("textRoot");
/** The blocks the correction editor holds: the text in force. */
const correctableIds = computed(
  () =>
    new Set(
      (document.value?.consolidatedVersion?.blocks ?? []).map(
        (block) => block.id,
      ),
    ),
);
const isCorrectable = (id: string) => correctableIds.value.has(id);
/**
 * The last block of the text the reader rested on (`READING_REST_MS`), inside
 * it: going back up to the button passes over every block above it.
 */
let lastReadBlockId: string | null = null;
const noteReadingPosition = useDebounceFn(() => {
  const root = textRoot.value;
  if (!root || correcting.value || !scrolledIntoText(root)) return;
  lastReadBlockId = blockAtReadingTop(root, isCorrectable) ?? lastReadBlockId;
}, READING_REST_MS);
useEventListener("scroll", noteReadingPosition, {
  capture: true,
  passive: true,
});
watch(
  () => document.value?.id,
  () => {
    lastReadBlockId = null;
  },
);
/** Where the button opens the editor (`amendStartBlockId`). */
function readingBlockId(): string | null {
  const root = textRoot.value;
  if (!root) return lastReadBlockId;
  return amendStartBlockId({
    selected: null,
    current: blockAtReadingTop(root, isCorrectable),
    lastRead: lastReadBlockId,
    // The header and the text scroll together here.
    atHeader: !scrolledIntoText(root),
  });
}
// Arriving from the document's «Más» menu (`?corregir`) opens the editor
// once the text is loaded, and drops the query so a reload does not.
const route = useRoute();
const router = useRouter();
watch(
  () =>
    route.query.corregir !== undefined &&
    Boolean(document.value?.can.correctForm) &&
    Boolean(document.value?.consolidatedVersion) &&
    formCorrections.value !== null,
  (ready) => {
    if (!ready) return;
    void router.replace({ query: { ...route.query, corregir: undefined } });
    startCorrection();
  },
  { immediate: true, flush: "post" },
);
/**
 * The text in force was corrected in form after the final vote (user's
 * decisions of 2026-11-21): it is shown as stored, without the amendments'
 * marks, which belong to the voted text. A text only conciliated after the
 * vote is still the one the approved amendments and wordings give, marks
 * included.
 */
const corrected = computed(
  () =>
    Boolean(document.value?.consolidatedVersion?.replacesVersionId) &&
    !sameBlocks(finalText.value, consolidation.value?.blocks),
);

useHead({
  title: () =>
    document.value
      ? `${t("workspace.consolidatedPage")}: ${document.value.title}`
      : t("workspace.consolidatedPage"),
});

const isPublished = computed(
  () => Boolean(document.value?.baseVersion) && base.value.length > 0,
);
const finalText = computed(
  () => document.value?.consolidatedVersion?.blocks ?? null,
);

const consolidation = computed(() =>
  base.value.length > 0
    ? consolidateApproved(
        base.value,
        consolidationInputs(list.amendments.value),
        { wordings: list.wordings.value },
      )
    : null,
);

// PDF pages -----------------------------------------------------------------------
// «pág. N» as the package's PDFs print it (user's decisions of 2026-11-21):
// the consolidated PDF's once voted (corrected and conciliated versions
// too); before, the original's, on its own blocks.

const { pages: pdfPages } = useDocumentPages(() =>
  documentPagesTarget(assembly.value?.id, document.value),
);
const textPages = computed(() =>
  finalText.value
    ? contentPages(
        pdfPages.value?.consolidated,
        document.value?.consolidatedVersion,
      )
    : contentPages(pdfPages.value?.base, document.value?.baseVersion),
);
const textPageTotal = computed(
  () =>
    (finalText.value
      ? pdfPages.value?.consolidated?.total
      : pdfPages.value?.base?.total) ?? 0,
);
const textPage = ref<number | null>(null);

/** Passages the Mesa has not worded yet, while the text is not final. */
const pendingPassages = computed(
  () =>
    consolidation.value?.passages.filter(
      (passage) => passage.status === "pending",
    ) ?? [],
);

// The provisional-text and pending-wordings notices show their title alone;
// «Ver detalles» unfolds the rest (M-053). Folded on the server and the
// client alike, and not remembered. Each toggle is described by its notice's
// title, so the two «Ver detalles» can be told apart.
const provisionalOpen = ref(false);
const provisionalTitleId = useId();
const provisionalDetailsId = useId();
const wordingsOpen = ref(false);
const wordingsTitleId = useId();
const wordingsDetailsId = useId();

// Pending conciliation ---------------------------------------------------------
// The final vote may approve the text with passages still to word (user's
// decisions of 2026-11-21): the version carries the automatic proposal
// there, marked in the text, until each passage is conciliated (directly
// with document:correct_form, proposed by its presenters).

const { codes: joinedCodes, marks: pendingMarksOf } = usePendingConciliation();
const conciliation = computed(
  () => document.value?.consolidatedVersion?.pendingPassages ?? [],
);
const pendingMarks = computed(() =>
  pendingMarksOf(document.value?.consolidatedVersion, list.labelOf),
);
const toast = useToast();
const api = useApi();
const conciliating = ref<Record<string, boolean>>({});
const wordingDialog = reactive({
  open: false,
  passageKey: null as string | null,
  editing: true,
});
const EMPTY_CONSOLIDATION = consolidateApproved([], []);
const wordingContext: WordingDialogContext = {
  wordingDialog,
  preview: computed(() => consolidation.value ?? EMPTY_CONSOLIDATION),
  amendments: computed(() => list.amendments.value),
  base: computed(() => base.value),
  busy: conciliating,
  label: (id: string) => list.labelOf(id),
  get purpose() {
    return document.value?.can.conciliate === "propose"
      ? "propose"
      : "conciliate";
  },
  async setWording(
    passage: Pick<Passage, "amendmentIds" | "blockIds">,
    ops: AmendmentOp[],
  ): Promise<boolean> {
    const version = document.value?.consolidatedVersion;
    if (!version || !documentApi.value) return false;
    const direct = document.value?.can.conciliate === "direct";
    const body: ConciliationBody = {
      fromVersionId: version.id,
      amendmentIds: passage.amendmentIds,
      blockIds: passage.blockIds,
      ops,
    };
    conciliating.value = { ...conciliating.value, wording: true };
    try {
      await api.send<FormCorrectionsDto>(`${documentApi.value}/conciliations`, {
        body,
      });
      toast.add({
        id: "conciliation-saved",
        title: direct
          ? t("document.pendingConciliation.toasts.applied")
          : t("document.pendingConciliation.toasts.proposed"),
        color: "success",
        icon: "i-lucide-git-merge",
      });
      await Promise.all([
        refreshDocument(),
        list.refresh(),
        formCorrections.value?.load(),
      ]);
      return true;
    } catch (error) {
      api.notifyError(error, "document.pendingConciliation.errors.save");
      if (api.isConflict(error)) void refreshDocument();
      return false;
    } finally {
      conciliating.value = { ...conciliating.value, wording: false };
    }
  },
  // Nothing to take back: a conciliation is a new version of the text.
  removeWording: async () => false,
};
function openConciliation(key: string): void {
  wordingDialog.passageKey = key;
  wordingDialog.editing = true;
  wordingDialog.open = true;
}

/**
 * The stored text after the final vote is authoritative. If the vote used an
 * application order this page cannot reproduce, show that text without
 * provenance rather than a different one.
 */
const provenanceMatches = computed(() => {
  if (!finalText.value || !consolidation.value) return true;
  const stored = finalText.value.map((block) => block.text);
  const computedText = consolidation.value.blocks.map((block) => block.text);
  return JSON.stringify(stored) === JSON.stringify(computedText);
});

const pendingCount = computed(
  () =>
    list.amendments.value.filter(
      (amendment) => amendment.status === "submitted",
    ).length,
);

const annex = computed(() =>
  OUTCOMES.map((status) => ({
    status,
    amendments: list.amendments.value.filter(
      (amendment) => amendment.status === status,
    ),
  })).filter((group) => group.amendments.length > 0),
);
const decidedCount = computed(() =>
  annex.value.reduce((sum, group) => sum + group.amendments.length, 0),
);

const expanded = ref<Set<string>>(new Set());
function toggleExpanded(id: string): void {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

// Fragment popover ----------------------------------------------------------------

const popoverOpen = ref(false);
const popoverReference = shallowRef<HTMLElement | null>(null);
const popoverAmendmentId = ref<string | null>(null);
let lastFragment: HTMLElement | null = null;

const popoverAmendment = computed(() =>
  popoverAmendmentId.value
    ? (list.byId.value.get(popoverAmendmentId.value) ?? null)
    : null,
);

/** Remembers the fragment under the pointer (or focus) before ContentView emits. */
function rememberFragment(event: Event): void {
  const target = event.target;
  lastFragment =
    target instanceof Element
      ? target.closest<HTMLElement>("[data-amendment-id]")
      : null;
}

function onFragmentClick(id: string): void {
  if (!lastFragment) return;
  popoverReference.value = lastFragment;
  popoverAmendmentId.value = id;
  popoverOpen.value = true;
}

watch(popoverOpen, (open) => {
  if (!open) popoverReference.value?.focus?.({ preventScroll: true });
});
</script>

<template>
  <div class="flex flex-col gap-6">
    <!-- Loading, then the error, then the text (no comment between the
         branches: Vue folds it into the next one, and hydration breaks). -->
    <div v-if="pending" class="flex flex-col gap-4" role="status">
      <span class="sr-only">{{ t("workspace.loading") }}</span>
      <USkeleton aria-hidden="true" class="h-4 w-32" />
      <USkeleton aria-hidden="true" class="h-8 w-3/4 max-w-xl" />
      <USkeleton aria-hidden="true" class="h-96 w-full" />
    </div>
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
      <!-- The way back is the breadcrumb row, above -->
      <template v-if="errorStatusCode !== 404" #action>
        <UButton
          icon="i-lucide-refresh-ccw"
          :label="t('workspace.retry')"
          @click="refreshAll"
        />
      </template>
    </CommonEmptyState>

    <template v-else>
      <DocumentHeader :document="document" :assembly="assembly">
        <template v-if="isPublished && document.format === 'structured'">
          <!-- The clean PDF prints the voted text; before the final vote the
               annotated one carries the approved amendments. -->
          <ExportButton
            v-if="document.consolidatedVersion"
            :assembly="assembly.id"
            :document="document.id"
            variant="clean"
          />
          <ExportButton
            :assembly="assembly.id"
            :document="document.id"
            variant="annotated"
          />
        </template>
      </DocumentHeader>

      <DocumentPdfViewer
        v-if="document.format === 'file'"
        :url="document.fileUrl"
        :title="document.title"
        :description="
          kindAcceptsFile(document.kind)
            ? undefined
            : t('workspace.text.fileDescription')
        "
      />

      <CommonEmptyState
        v-else-if="!isPublished || !consolidation"
        icon="i-lucide-file-clock"
        :title="t('workspace.consolidatedView.unpublished')"
        :description="t('workspace.consolidatedView.unpublishedDescription')"
        variant="outline"
      />

      <template v-else>
        <!-- Status of the text. On a phone the sections take no box of
             their own, so the text starts higher (M-041). -->
        <section
          v-if="document.finalVote"
          class="sm:border-default flex flex-col gap-3 sm:rounded-lg sm:border sm:p-5"
          aria-labelledby="consolidated-final-vote"
        >
          <h2
            id="consolidated-final-vote"
            class="text-highlighted text-base font-semibold"
          >
            {{ t("workspace.consolidatedView.finalVote") }}
          </h2>
          <AmendmentVoteSummary :vote="document.finalVote" />
        </section>
        <!-- Approved pending conciliation (user's decisions of 2026-11-21):
             never read as the final text; each passage is conciliated
             here, or its wording proposed by the presenters. -->
        <UAlert
          v-if="document.finalVote && conciliation.length > 0"
          color="warning"
          variant="subtle"
          icon="i-lucide-git-merge"
          :title="t('document.pendingConciliation.status')"
        >
          <template #description>
            <p>
              {{
                t(
                  "document.pendingConciliation.description",
                  { count: conciliation.length },
                  conciliation.length,
                )
              }}
            </p>
            <ul class="mt-2 flex flex-col gap-1.5">
              <li
                v-for="passage in conciliation"
                :key="passage.key"
                class="flex flex-wrap items-center gap-2"
              >
                <span>{{
                  t("document.pendingConciliation.passage", {
                    codes: joinedCodes(passage.amendmentIds, list.labelOf),
                  })
                }}</span>
                <UButton
                  v-if="document.can.conciliate"
                  size="xs"
                  color="neutral"
                  variant="outline"
                  icon="i-lucide-git-merge"
                  :label="
                    document.can.conciliate === 'direct'
                      ? t('document.pendingConciliation.conciliate')
                      : t('document.pendingConciliation.propose')
                  "
                  @click="openConciliation(passage.key)"
                />
              </li>
            </ul>
          </template>
        </UAlert>
        <!-- The provisional-text and pending-wordings notices: one line
             each, the title and a «Ver detalles» link after it; the rest
             shows only once unfolded (M-053). The conciliation notice above
             carries buttons and stays unfolded. -->
        <UAlert
          v-if="!document.finalVote"
          color="info"
          variant="subtle"
          icon="i-lucide-hourglass"
        >
          <template #title>
            <div class="flex flex-wrap items-baseline gap-x-2">
              <span :id="provisionalTitleId">{{
                t("workspace.consolidatedView.provisional")
              }}</span>
              <UButton
                color="neutral"
                variant="link"
                size="xs"
                class="-my-1 px-0"
                :trailing-icon="
                  provisionalOpen
                    ? 'i-lucide-chevron-up'
                    : 'i-lucide-chevron-down'
                "
                :label="
                  provisionalOpen
                    ? t('workspace.consolidatedView.hideDetails')
                    : t('workspace.consolidatedView.showDetails')
                "
                :aria-expanded="provisionalOpen"
                :aria-controls="provisionalDetailsId"
                :aria-describedby="provisionalTitleId"
                @click="provisionalOpen = !provisionalOpen"
              />
            </div>
          </template>
          <template v-if="provisionalOpen" #description>
            <p :id="provisionalDetailsId">
              {{
                pendingCount > 0
                  ? t(
                      "workspace.consolidatedView.pending",
                      { count: pendingCount },
                      pendingCount,
                    )
                  : t("workspace.consolidatedView.provisionalDescription")
              }}
            </p>
          </template>
        </UAlert>

        <UAlert
          v-if="!finalText && pendingPassages.length > 0"
          color="info"
          variant="subtle"
          icon="i-lucide-pen-line"
        >
          <template #title>
            <div class="flex flex-wrap items-baseline gap-x-2">
              <span :id="wordingsTitleId">{{
                t(
                  "workspace.consolidated.pendingWordings",
                  { count: pendingPassages.length },
                  pendingPassages.length,
                )
              }}</span>
              <UButton
                color="neutral"
                variant="link"
                size="xs"
                class="-my-1 px-0"
                :trailing-icon="
                  wordingsOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'
                "
                :label="
                  wordingsOpen
                    ? t('workspace.consolidatedView.hideDetails')
                    : t('workspace.consolidatedView.showDetails')
                "
                :aria-expanded="wordingsOpen"
                :aria-controls="wordingsDetailsId"
                :aria-describedby="wordingsTitleId"
                @click="wordingsOpen = !wordingsOpen"
              />
            </div>
          </template>
          <template v-if="wordingsOpen" #description>
            <p :id="wordingsDetailsId">
              {{
                pendingPassages
                  .map((passage) =>
                    passage.amendmentIds
                      .map((id) => list.labelOf(id))
                      .join(", "),
                  )
                  .join(" · ")
              }}
            </p>
          </template>
        </UAlert>
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

        <!-- Text -->
        <!-- The text keeps the editor's measure (`main.css`), centred. Its
             heading names the section for screen readers (the page's title
             already says what it is); the row above the text shows only for
             the correction's button. -->
        <section
          v-if="!correcting"
          ref="textRoot"
          class="sm:border-default sm:rounded-lg sm:border sm:p-6 lg:px-[max(1.5rem,calc((100%_-_52rem)/2))]"
          aria-labelledby="consolidated-text"
        >
          <h2 id="consolidated-text" class="sr-only">
            {{ t("workspace.consolidatedView.text") }}
          </h2>
          <div
            v-if="document.can.correctForm && document.consolidatedVersion"
            class="mb-4 flex justify-end"
          >
            <UButton
              size="sm"
              color="neutral"
              variant="outline"
              icon="i-lucide-spell-check"
              :label="
                document.can.correctForm === 'direct'
                  ? t('workspace.formCorrections.edit')
                  : t('workspace.formCorrections.propose')
              "
              @click="startCorrection(readingBlockId())"
            />
          </div>

          <!-- The PDF page being read, kept in view as the text scrolls. -->
          <ContentPageIndicator
            :page="textPage"
            :total="textPageTotal"
            floating
          />
          <template v-if="corrected && finalText">
            <UAlert
              color="neutral"
              variant="subtle"
              icon="i-lucide-spell-check"
              class="mb-4"
              :title="t('workspace.formCorrections.correctedText')"
            />
            <ContentView
              :blocks="finalText"
              :pending="pendingMarks"
              :pages="textPages"
              @page="textPage = $event"
            />
          </template>
          <template v-else-if="provenanceMatches">
            <p
              v-if="consolidation.applied.length > 0"
              class="text-muted mb-4 text-sm"
            >
              {{ t("workspace.consolidatedView.legend") }}
            </p>
            <div
              @click.capture="rememberFragment"
              @keydown.capture="rememberFragment"
            >
              <ContentView
                :annotated="consolidation.annotated"
                mode="provenance"
                :label="list.shortLabelOf"
                :focus="popoverOpen ? popoverAmendmentId : null"
                :pending="pendingMarks"
                :pages="textPages"
                interactive
                @amendment-click="onFragmentClick"
                @page="textPage = $event"
              />
            </div>
          </template>
          <template v-else-if="finalText">
            <UAlert
              color="neutral"
              variant="subtle"
              icon="i-lucide-info"
              class="mb-4"
              :title="t('workspace.consolidatedView.storedOnly')"
            />
            <ContentView
              :blocks="finalText"
              :pending="pendingMarks"
              :pages="textPages"
              @page="textPage = $event"
            />
          </template>
        </section>

        <!-- Corrections of form after the final vote. -->
        <DocumentFormCorrections
          v-if="document.finalVote && document.consolidatedVersion"
          ref="formCorrections"
          v-model:editing="correcting"
          :document="document"
          :document-api="documentApi"
          :label-of="list.labelOf"
          :pages="textPages"
          @changed="refreshDocument"
        />
        <!-- An approved acta, signed by the Secretaría (user's decision of
             2026-11-26): its managers only, never while correcting. -->
        <SigningPanel
          v-if="document.signing && !correcting"
          :signing="document.signing.state"
          :approved="document.signing.ready"
          :title="document.title"
          :base="`${documentApi}/signing`"
          :not-yet="
            document.signing.signer
              ? t('documentSigning.notYet')
              : t('documentSigning.noSigner')
          "
          :intro="
            t('documentSigning.intro', { name: document.signing.signer ?? '' })
          "
          :warning="
            document.signing.closingInText
              ? t('documentSigning.closingInText')
              : null
          "
          @update="refreshDocument()"
          @stale="refreshDocument()"
        />
        <SessionWordingDialog
          v-if="document.can.conciliate"
          :context="wordingContext"
        />

        <UPopover
          v-model:open="popoverOpen"
          :reference="popoverReference ?? undefined"
          :content="{ side: 'bottom', align: 'start', collisionPadding: 12 }"
        >
          <template #content>
            <div
              v-if="popoverAmendment"
              class="flex w-80 max-w-[90vw] flex-col gap-3 p-3"
            >
              <AmendmentSummary
                :amendment="popoverAmendment"
                :label="list.labelOf(popoverAmendment.id)"
                :label-of="list.labelOf"
                :by-id="list.byId.value"
                show-justification
              />
              <UButton
                :to="documentPath()"
                color="neutral"
                variant="outline"
                size="xs"
                icon="i-lucide-panels-top-left"
                class="self-start"
                :label="t('workspace.consolidatedView.openWorkspace')"
              />
            </div>
          </template>
        </UPopover>

        <!-- Annex -->
        <section
          class="flex flex-col gap-4"
          aria-labelledby="consolidated-annex"
        >
          <div>
            <h2
              id="consolidated-annex"
              class="text-highlighted text-lg font-semibold"
            >
              {{ t("workspace.consolidatedView.annex") }}
            </h2>
            <p class="text-muted text-sm">
              {{
                t(
                  "workspace.consolidatedView.annexDescription",
                  { count: decidedCount },
                  decidedCount,
                )
              }}
            </p>
          </div>

          <div
            v-if="list.pending.value && list.amendments.value.length === 0"
            class="flex flex-col gap-3"
            role="status"
          >
            <span class="sr-only">{{ t("amendment.list.loading") }}</span>
            <USkeleton
              v-for="i in 3"
              :key="i"
              aria-hidden="true"
              class="h-20 w-full"
            />
          </div>

          <UAlert
            v-else-if="list.error.value && list.amendments.value.length === 0"
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

          <template v-else>
            <section
              v-for="group in annex"
              :key="group.status"
              class="flex flex-col gap-2"
              :aria-labelledby="`annex-${group.status}`"
            >
              <h3
                :id="`annex-${group.status}`"
                class="text-highlighted flex items-center gap-2 text-sm font-semibold"
              >
                {{ t(`workspace.consolidatedView.outcomes.${group.status}`) }}
                <UBadge
                  color="neutral"
                  variant="soft"
                  size="md"
                  :label="String(group.amendments.length)"
                />
              </h3>
              <ul class="flex flex-col gap-2">
                <li
                  v-for="amendment in group.amendments"
                  :key="amendment.id"
                  class="border-default rounded-lg border p-3"
                >
                  <AmendmentSummary
                    :amendment="amendment"
                    :label="list.labelOf(amendment.id)"
                    :label-of="list.labelOf"
                    :by-id="list.byId.value"
                    :heading-level="4"
                  >
                    <UButton
                      color="neutral"
                      variant="link"
                      size="xs"
                      class="self-start px-0"
                      :icon="
                        expanded.has(amendment.id)
                          ? 'i-lucide-chevron-up'
                          : 'i-lucide-chevron-down'
                      "
                      :aria-expanded="expanded.has(amendment.id)"
                      :aria-controls="`annex-diff-${amendment.id}`"
                      :label="
                        expanded.has(amendment.id)
                          ? t('workspace.consolidatedView.hideChanges')
                          : t('workspace.consolidatedView.showChanges')
                      "
                      @click="toggleExpanded(amendment.id)"
                    />
                    <div
                      v-if="expanded.has(amendment.id)"
                      :id="`annex-diff-${amendment.id}`"
                      class="border-default flex flex-col gap-3 border-t pt-3"
                    >
                      <ContentAmendmentDiff
                        :id="amendment.id"
                        :base="base"
                        :ops="amendment.ops"
                        :context="1"
                      />
                      <p
                        v-if="amendment.justification"
                        class="content-font text-muted text-sm whitespace-pre-line"
                      >
                        {{ amendment.justification }}
                      </p>
                    </div>
                  </AmendmentSummary>
                </li>
              </ul>
            </section>
          </template>
        </section>
      </template>
    </template>
  </div>
</template>
