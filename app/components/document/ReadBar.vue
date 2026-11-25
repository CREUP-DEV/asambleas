<script setup lang="ts">
import type { RouteLocationRaw } from "vue-router";
import type { DocumentSummaryDto } from "~~/shared/types/api";
import { readNeighbours } from "~~/shared/utils/readMarks";

/**
 * Reading the documentation one document after another: where this document
 * sits among the published ones, in the order of the agenda, with the ones
 * before and after it, what is left to read (which opens the next one with
 * something left) and its read mark (reading it to its end marks it read;
 * the button takes that back). It stands above the document's
 * title, so going through every document never needs the lists. The page
 * of an agenda item shows it over its reader, and there the documents open
 * in that reader (`to`) instead of on their own page.
 *
 * Only for a published document. The way through comes from the agenda,
 * which the server already renders, so the bar takes its place at once:
 * what needs the read marks (what is left and the mark) holds a placeholder
 * of the same size until they arrive, and the page never moves when they do.
 * If their read fails, those places stay empty.
 *
 * Below md it takes two rows: the arrows at the ends with the position and
 * the mark between them, and what is left underneath. From md, one row.
 * Where an arrow leads is in its name and in a tooltip.
 */
const props = withDefaults(
  defineProps<{
    document: Pick<DocumentSummaryDto, "id" | "status">;
    /** Where another document opens; its own page when left out. */
    to?: (document: DocumentSummaryDto) => RouteLocationRaw;
    /**
     * Only the way through: the documents before and after it and its
     * position, for the folded header of a document being read.
     */
    compact?: boolean;
    /** Folded away, animated (CommonCollapse): its height, or compact its width. */
    hidden?: boolean;
  }>(),
  { to: undefined, compact: false, hidden: false },
);

const { t } = useI18n();
const { sectionPath } = useCurrentAssembly();
const marks = useReadMarks();
const { data: agenda } = useAssemblyAgenda();

/** The read marks are in (they are fetched in the browser only). */
const loaded = computed(() => marks.marks.value !== null);
/**
 * Their first read failed: nothing is on its way, so the bar keeps the way
 * through and leaves out what needs them instead of a placeholder that
 * never ends. They fill in if a later read brings them.
 */
const waiting = computed(() => !loaded.value && !marks.failed.value);

/**
 * The published documents, in the order the agenda reads: the ones that
 * take a mark once the marks are in, the agenda's published ones before.
 */
const ordered = computed(() =>
  documentsInAgendaOrder(
    buildAgendaTree(agenda.value?.items ?? []),
    agenda.value?.documents ?? [],
  ).filter((document) =>
    loaded.value
      ? marks.document(document.id) !== null
      : document.status === "published",
  ),
);

const position = computed(() =>
  readNeighbours(ordered.value, props.document.id, marks.index.value),
);
const mark = computed(() => marks.document(props.document.id));

const shown = computed(
  () =>
    position.value.index >= 0 &&
    (loaded.value
      ? mark.value !== null
      : props.document.status === "published"),
);

const pathOf = (document: DocumentSummaryDto): RouteLocationRaw =>
  props.to
    ? props.to(document)
    : sectionPath(`documentos/${encodeURIComponent(document.slug)}`);

/** "Anterior: <title>", or only "Anterior" when there is none. */
const previousLabel = computed(() =>
  position.value.previous
    ? t("readMarks.bar.previousTo", { title: position.value.previous.title })
    : t("common.previous"),
);
const nextLabel = computed(() =>
  position.value.next
    ? t("readMarks.bar.nextTo", { title: position.value.next.title })
    : t("common.next"),
);

/** "3 documentos y 2 enmiendas", what is left in the whole assembly. */
const left = useReadLeftText(() => marks.progress.value);

/** Amendments to this document still to read. */
const amendmentsHere = computed(
  () => marks.index.value.amendmentsLeft.get(props.document.id) ?? 0,
);

/** What the bar says about this document, before what is left. */
const note = computed<"changed" | "amendments" | null>(() => {
  if (mark.value?.state === "changed" && !mark.value.own) return "changed";
  return amendmentsHere.value > 0 ? "amendments" : null;
});
</script>

<template>
  <CommonCollapse v-if="shown" :open="!hidden" :axis="compact ? 'x' : 'y'">
    <nav
      v-if="compact"
      class="flex shrink-0 items-center gap-0.5 text-sm"
      :aria-label="t('readMarks.bar.label')"
      data-testid="document-read-bar"
    >
      <UTooltip :text="previousLabel" :disabled="!position.previous">
        <UButton
          icon="i-lucide-chevron-left"
          color="neutral"
          variant="ghost"
          size="sm"
          rel="prev"
          :to="position.previous ? pathOf(position.previous) : undefined"
          :disabled="!position.previous"
          :aria-label="previousLabel"
          data-testid="read-bar-previous"
        />
      </UTooltip>
      <span class="text-muted px-1 whitespace-nowrap tabular-nums">
        {{
          t("readMarks.bar.position", {
            index: position.index + 1,
            total: position.total,
          })
        }}
      </span>
      <UTooltip :text="nextLabel" :disabled="!position.next">
        <UButton
          icon="i-lucide-chevron-right"
          color="neutral"
          variant="ghost"
          size="sm"
          rel="next"
          :to="position.next ? pathOf(position.next) : undefined"
          :disabled="!position.next"
          :aria-label="nextLabel"
          data-testid="read-bar-next"
        />
      </UTooltip>
    </nav>
    <!-- Below md: ‹ | position over the mark | ›, then what is left.
         From md: ‹ | position | what is left | mark | ›. -->
    <nav
      v-else
      class="border-default bg-elevated/40 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-1 gap-y-1.5 rounded-lg border p-1.5 text-sm md:grid-cols-[auto_auto_minmax(0,1fr)_auto_auto] md:gap-x-3 md:px-2"
      :aria-label="t('readMarks.bar.label')"
      data-testid="document-read-bar"
    >
      <UTooltip :text="previousLabel" :disabled="!position.previous">
        <UButton
          icon="i-lucide-chevron-left"
          color="neutral"
          variant="ghost"
          size="sm"
          rel="prev"
          class="col-start-1 row-span-2 row-start-1 min-h-11 min-w-11 justify-center md:row-span-1 md:min-h-0 md:min-w-0"
          :to="position.previous ? pathOf(position.previous) : undefined"
          :disabled="!position.previous"
          :aria-label="previousLabel"
          data-testid="read-bar-previous"
        >
          <span class="hidden xl:inline">{{ t("common.previous") }}</span>
        </UButton>
      </UTooltip>

      <span
        class="text-default col-start-2 row-start-1 justify-self-center text-center font-medium tabular-nums md:justify-self-start md:whitespace-nowrap"
      >
        {{
          t("readMarks.bar.position", {
            index: position.index + 1,
            total: position.total,
          })
        }}
      </span>

      <!-- Each «·» goes with the words after it, never alone at a line's end;
           the first one only from md, where the position stands before it. -->
      <div
        class="text-muted col-span-3 col-start-1 row-start-3 min-w-0 text-center md:col-span-1 md:col-start-3 md:row-start-1 md:text-start"
      >
        <template v-if="waiting">
          <USkeleton
            aria-hidden="true"
            class="mx-auto my-0.5 h-4 w-72 max-w-full md:mx-0"
          />
          <USkeleton
            aria-hidden="true"
            class="mx-auto my-0.5 h-4 w-40 max-w-full sm:hidden"
          />
        </template>
        <template v-else-if="loaded">
          <span
            v-if="note === 'changed'"
            class="text-default"
            data-testid="read-bar-changed"
          >
            <span aria-hidden="true" class="max-md:hidden">·&nbsp;</span>
            <UIcon
              name="i-lucide-refresh-cw"
              class="text-warning me-1 inline-block size-4 align-[-0.1875em]"
              aria-hidden="true"
            />{{ t("readMarks.changedNote.document") }}
          </span>
          <span
            v-else-if="note === 'amendments'"
            data-testid="read-bar-amendments"
          >
            <span aria-hidden="true" class="max-md:hidden">·&nbsp;</span
            >{{
              t(
                "readMarks.amendmentsHere",
                { count: amendmentsHere },
                amendmentsHere,
              )
            }}
          </span>
          <span v-if="left"
            >{{ " "
            }}<span aria-hidden="true" :class="{ 'max-md:hidden': !note }"
              >·&nbsp;</span
            ><UTooltip
              v-if="position.nextLeft"
              :text="
                t('readMarks.bar.nextLeft', { title: position.nextLeft.title })
              "
            >
              <ULink
                :to="pathOf(position.nextLeft)"
                class="text-primary hover:underline"
                data-testid="read-bar-left"
                >{{ t("readMarks.bar.left", { items: left }) }}</ULink
              >
            </UTooltip>
            <span v-else data-testid="read-bar-left">{{
              t("readMarks.bar.left", { items: left })
            }}</span>
          </span>
          <span v-else data-testid="read-bar-done"
            >{{ " "
            }}<span aria-hidden="true" :class="{ 'max-md:hidden': !note }"
              >·&nbsp;</span
            ><UIcon
              name="i-lucide-check-check"
              class="text-success me-1 inline-block size-4 align-[-0.1875em]"
              aria-hidden="true"
            />{{ t("readMarks.allRead") }}
          </span>
        </template>
      </div>

      <div
        class="col-start-2 row-start-2 flex justify-self-center md:col-start-4 md:row-start-1 md:justify-self-end"
      >
        <ReadToggle v-if="loaded" :id="document.id" kind="document" />
        <USkeleton v-else-if="waiting" aria-hidden="true" class="h-7 w-36" />
      </div>

      <UTooltip :text="nextLabel" :disabled="!position.next">
        <UButton
          trailing-icon="i-lucide-chevron-right"
          color="neutral"
          variant="ghost"
          size="sm"
          rel="next"
          class="col-start-3 row-span-2 row-start-1 min-h-11 min-w-11 justify-center md:col-start-5 md:row-span-1 md:min-h-0 md:min-w-0"
          :to="position.next ? pathOf(position.next) : undefined"
          :disabled="!position.next"
          :aria-label="nextLabel"
          data-testid="read-bar-next"
        >
          <span class="hidden xl:inline">{{ t("common.next") }}</span>
        </UButton>
      </UTooltip>
    </nav>
  </CommonCollapse>
</template>
