<script setup lang="ts">
import type { RouteLocationRaw } from "vue-router";
import type { DocumentSummaryDto } from "~~/shared/types/api";
import { readNeighbours } from "~~/shared/utils/readMarks";

/**
 * Reading the documentation one document after another: where this document
 * sits among the published ones, in the order of the agenda, with the ones
 * before and after it, what is left to read (which opens the next one with
 * something left) and "Marcar como leído". It stands above the document's
 * title, so going through every document never needs the lists. The page
 * of an agenda item shows it over its reader, and there the documents open
 * in that reader (`to`) instead of on their own page.
 *
 * Only for a published document, and once the read marks and the agenda are
 * in: before that, and for a draft, the page shows nothing here.
 */
const props = withDefaults(
  defineProps<{
    document: Pick<DocumentSummaryDto, "id">;
    /** Where another document opens; its own page when left out. */
    to?: (document: DocumentSummaryDto) => RouteLocationRaw;
  }>(),
  { to: undefined },
);

const { t } = useI18n();
const { sectionPath } = useCurrentAssembly();
const marks = useReadMarks();
const { data: agenda } = useAssemblyAgenda();

/** The published documents, in the order the agenda reads. */
const ordered = computed(() =>
  documentsInAgendaOrder(
    buildAgendaTree(agenda.value?.items ?? []),
    agenda.value?.documents ?? [],
  ).filter((document) => marks.document(document.id) !== null),
);

const position = computed(() =>
  readNeighbours(ordered.value, props.document.id, marks.index.value),
);
const mark = computed(() => marks.document(props.document.id));

const pathOf = (document: DocumentSummaryDto): RouteLocationRaw =>
  props.to
    ? props.to(document)
    : sectionPath(`documentos/${encodeURIComponent(document.slug)}`);

/** "3 documentos y 2 enmiendas", what is left in the whole assembly. */
const left = useReadLeftText(() => marks.progress.value);

/** Amendments to this document still to read. */
const amendmentsHere = computed(
  () => marks.index.value.amendmentsLeft.get(props.document.id) ?? 0,
);
</script>

<template>
  <nav
    v-if="mark && position.index >= 0"
    class="border-default bg-elevated/40 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-2 py-1.5 text-sm"
    :aria-label="t('readMarks.bar.label')"
    data-testid="document-read-bar"
  >
    <UButton
      icon="i-lucide-chevron-left"
      color="neutral"
      variant="ghost"
      size="sm"
      rel="prev"
      :to="position.previous ? pathOf(position.previous) : undefined"
      :disabled="!position.previous"
      :label="t('common.previous')"
      :title="position.previous?.title"
      data-testid="read-bar-previous"
    />

    <p class="text-muted flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span class="text-default font-medium whitespace-nowrap tabular-nums">
        {{
          t("readMarks.bar.position", {
            index: position.index + 1,
            total: position.total,
          })
        }}
      </span>
      <template v-if="left">
        <span aria-hidden="true">·</span>
        <ULink
          v-if="position.nextLeft"
          :to="pathOf(position.nextLeft)"
          class="text-primary hover:underline"
          :title="
            t('readMarks.bar.nextLeft', { title: position.nextLeft.title })
          "
          data-testid="read-bar-left"
        >
          {{ t("readMarks.bar.left", { items: left }) }}
        </ULink>
        <span v-else data-testid="read-bar-left">
          {{ t("readMarks.bar.left", { items: left }) }}
        </span>
      </template>
      <span
        v-else
        class="inline-flex items-center gap-1"
        data-testid="read-bar-done"
      >
        <span aria-hidden="true">·</span>
        <UIcon
          name="i-lucide-check-check"
          class="text-success size-4 shrink-0"
          aria-hidden="true"
        />
        {{ t("readMarks.allRead") }}
      </span>
    </p>

    <div class="ms-auto flex flex-wrap items-center gap-x-3 gap-y-2">
      <span
        v-if="mark.state === 'changed' && !mark.own"
        class="text-default inline-flex items-center gap-1.5"
        data-testid="read-bar-changed"
      >
        <UIcon
          name="i-lucide-refresh-cw"
          class="text-warning size-4 shrink-0"
          aria-hidden="true"
        />
        {{ t("readMarks.changedNote.document") }}
      </span>
      <span
        v-else-if="amendmentsHere > 0"
        class="text-muted"
        data-testid="read-bar-amendments"
      >
        {{
          t(
            "readMarks.amendmentsHere",
            { count: amendmentsHere },
            amendmentsHere,
          )
        }}
      </span>
      <ReadToggle :id="document.id" kind="document" />
      <UButton
        trailing-icon="i-lucide-chevron-right"
        color="neutral"
        variant="ghost"
        size="sm"
        rel="next"
        :to="position.next ? pathOf(position.next) : undefined"
        :disabled="!position.next"
        :label="t('common.next')"
        :title="position.next?.title"
        data-testid="read-bar-next"
      />
    </div>
  </nav>
</template>
