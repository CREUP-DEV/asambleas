<script setup lang="ts">
import type { AmendmentStatus } from "~~/shared/constants/domain";
import { consolidate } from "~~/shared/utils/content/consolidate";
import { consolidationInputs } from "~/composables/amendment/workspace";

/**
 * Consolidated text of a document (inside the assembly hub): the base with
 * every approved amendment applied, each amended fragment marked with its
 * amendment code. Clicking a fragment shows that amendment, its outcome and
 * its vote. Below come the final vote (when held) and an annex of every
 * amendment by outcome. Clean and annotated PDFs are exported from here.
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
} = workspace;

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
    ? consolidate(base.value, consolidationInputs(list.amendments.value))
    : null,
);

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
  })),
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
    <!-- Loading -->
    <div
      v-if="pending"
      class="flex flex-col gap-4"
      aria-busy="true"
      :aria-label="t('workspace.loading')"
    >
      <USkeleton class="h-4 w-32" />
      <USkeleton class="h-8 w-3/4 max-w-xl" />
      <USkeleton class="h-96 w-full" />
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
          :to="documentPath()"
          icon="i-lucide-arrow-left"
          color="neutral"
          variant="outline"
          size="sm"
          :label="t('workspace.consolidatedView.back')"
        />
        <template v-if="isPublished && document.format === 'structured'">
          <ExportButton
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

      <CommonEmptyState
        v-else-if="!isPublished || !consolidation"
        icon="i-lucide-file-clock"
        :title="t('workspace.consolidatedView.unpublished')"
        :description="t('workspace.consolidatedView.unpublishedDescription')"
        variant="outline"
      />

      <template v-else>
        <!-- Status of the text -->
        <section
          v-if="document.finalVote"
          class="border-default flex flex-col gap-3 rounded-lg border p-4 sm:p-5"
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
        <UAlert
          v-else
          color="info"
          variant="subtle"
          icon="i-lucide-hourglass"
          :title="t('workspace.consolidatedView.provisional')"
          :description="
            pendingCount > 0
              ? t(
                  'workspace.consolidatedView.pending',
                  { count: pendingCount },
                  pendingCount,
                )
              : t('workspace.consolidatedView.provisionalDescription')
          "
        />

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
        <section
          class="border-default rounded-lg border p-4 sm:p-6"
          aria-labelledby="consolidated-text"
        >
          <div class="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <h2
              id="consolidated-text"
              class="text-highlighted text-base font-semibold"
            >
              {{ t("workspace.consolidatedView.text") }}
            </h2>
            <p
              v-if="provenanceMatches && consolidation.applied.length > 0"
              class="text-muted text-sm"
            >
              {{ t("workspace.consolidatedView.legend") }}
            </p>
          </div>

          <template v-if="provenanceMatches">
            <div
              @click.capture="rememberFragment"
              @keydown.capture="rememberFragment"
            >
              <ContentView
                :annotated="consolidation.annotated"
                mode="provenance"
                :label="list.shortLabelOf"
                :focus="popoverOpen ? popoverAmendmentId : null"
                interactive
                @amendment-click="onFragmentClick"
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
            <ContentView :blocks="finalText" />
          </template>
        </section>

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
            aria-busy="true"
          >
            <USkeleton v-for="i in 3" :key="i" class="h-20 w-full" />
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
                  size="xs"
                  :label="String(group.amendments.length)"
                />
              </h3>
              <p
                v-if="group.amendments.length === 0"
                class="text-muted text-sm"
              >
                {{ t("workspace.consolidatedView.none") }}
              </p>
              <ul v-else class="flex flex-col gap-2">
                <li
                  v-for="amendment in group.amendments"
                  :key="amendment.id"
                  class="border-default rounded-lg border p-3"
                >
                  <AmendmentSummary
                    :amendment="amendment"
                    :label="list.labelOf(amendment.id)"
                    :label-of="list.labelOf"
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
