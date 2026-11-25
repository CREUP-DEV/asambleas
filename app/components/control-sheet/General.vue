<script setup lang="ts">
import type { MemberDto } from "~~/shared/types/api";
import {
  DEFAULT_GENERAL_SORT,
  type GeneralSortKey,
  type SheetSort,
} from "./-filters";
import {
  itemTreatedControl,
  itemVoteNeedsLabel,
  rowVoteEntries,
  type GeneralSheetRow,
  type SheetRowDocument,
  type TreatedBox,
} from "./-model";
import { generalOwnNotes, type OwnSheetNotes } from "./-readers";
import { rowClickOpens } from "./-rowClick";

/**
 * «General» of the control sheet: one row per agenda item it lists, under
 * the items they hang from. A table on large screens, a card per row below
 * them, both with the same fields. The row the Mesa has in debate is
 * marked (aria-current and a ring). «Tratado» only shows here, to every
 * reader (user's decision of 2026-11-19); the Mesa marks it in the row's
 * panel. Each document's title links to its page, and the eye beside it
 * opens it in a floating window without leaving the sheet («Vista previa»).
 *
 * `rows` are the ones the page shows, already filtered and sorted; the
 * headers sort by their column (`sort`). In any order but the agenda's
 * (`flat`) there are no headings, so each row names the item it hangs
 * from; the one exception is a heading the Mesa has in debate, kept in its
 * sorted place and marked like any row in debate.
 */
const props = defineProps<{
  rows: GeneralSheetRow[];
  documentPath: (document: SheetRowDocument) => string;
  /** Every member by id, for the presenters' cards (empty while loading). */
  members: ReadonlyMap<string, MemberDto>;
  /**
   * The reader edits something in a row's panel (control_sheet:edit or the
   * Mesa): the button that opens it reads «Editar» with a pencil, «Ver» with
   * an eye otherwise.
   */
  canEdit: boolean;
  /**
   * Marks the panel has on their way, by item id: the value the box shows
   * meanwhile.
   */
  treatedPending: Readonly<Record<string, boolean>>;
  sort: SheetSort<GeneralSortKey>;
  flat: boolean;
  /**
   * A sheet key (ControlSheetDto.can.internal): who spoke and the
   * observations. Without it those columns are not there.
   */
  internal: boolean;
  /**
   * The amendments the reader sees of each document, by id (those without
   * any are left out): a document with some opens them in «Enmiendas».
   */
  amendmentCounts: ReadonlyMap<string, number>;
  /**
   * «Mis notas» for a reader without the sheet's key to edit (user's
   * decision of 2026-11-21): the account's own notes; null when the column
   * is not there.
   */
  ownNotes?: OwnSheetNotes | null;
}>();
const emit = defineEmits<{
  open: [row: GeneralSheetRow];
  sort: [column: GeneralSortKey];
  /** Open this document's amendments in «Enmiendas». */
  amendments: [document: SheetRowDocument];
  /** Read this document in a floating window, without leaving the sheet. */
  preview: [document: SheetRowDocument];
}>();

/** How many amendments of the document «Enmiendas» lists, 0 if none. */
const amendmentsOf = (document: SheetRowDocument) =>
  props.amendmentCounts.get(document.id) ?? 0;

/**
 * «N sin responder» beside a document the reader presents (user's decision
 * of 2026-11-21): its amendments waiting for its presenters' answer.
 */
const awaitingOf = (document: SheetRowDocument | null) =>
  document?.presenting ? document.awaitingAnswer : 0;

/** «Mis notas» of the row, when the column is there. */
const notesOf = (row: GeneralSheetRow) =>
  props.ownNotes ? generalOwnNotes(row, props.ownNotes) : [];

/** The row's box: what is on its way first, then what the sheet says. */
function treatedOf(row: GeneralSheetRow): TreatedBox {
  const pending = props.treatedPending[row.id];
  return pending === undefined
    ? { treated: itemTreatedControl(row).treated, saving: false }
    : { treated: pending, saving: true };
}

/**
 * The row's own document when the item is just that document (its
 * automatic sub-item, titled after it): the title links to it, and the
 * list under it does not repeat it.
 */
function ownDocument(row: GeneralSheetRow): SheetRowDocument | null {
  const [only] = row.documents;
  return row.documents.length === 1 && only && only.title === row.title
    ? only
    : null;
}

/** The documents listed under the title: all but the row's own. */
function listedDocuments(row: GeneralSheetRow): SheetRowDocument[] {
  const own = ownDocument(row);
  return own ? [] : row.documents;
}

const openIcon = computed(() =>
  props.canEdit ? "i-lucide-square-pen" : "i-lucide-eye",
);
const openButton = computed(() =>
  props.canEdit
    ? t("controlSheet.edit.button")
    : t("controlSheet.columns.open"),
);
/** «Editar el punto 3.1. Title», or «Ver…» for whoever only reads. */
function openLabel(row: GeneralSheetRow): string {
  return t(
    props.canEdit ? "controlSheet.edit.item" : "controlSheet.open.item",
    {
      title: rowLabel(row),
    },
  );
}

/** «Vista previa de «Title»», for the eye beside a document's title. */
const previewLabel = (document: SheetRowDocument) =>
  t("controlSheet.preview.documentAria", { title: document.title });

/** "3.1. Title" for the button that opens a row. */
const rowLabel = (row: GeneralSheetRow) =>
  numberedAgendaTitle(row.number, row.title, t("agenda.unlisted.inText"));

const { t } = useI18n();

/**
 * The documents' final votes, or the votes on the item in force (the
 * latest gives the result), each named by its question only when that adds
 * something to the row (itemVoteNeedsLabel). With more than one vote on the
 * item in force, the one that gives the result says so (`decidesShown`),
 * as in the panel.
 */
const votesOf = (row: GeneralSheetRow) => {
  const entries = rowVoteEntries(row);
  const ownInForce = entries.filter((entry) => entry.ownVote).length;
  return entries.map((entry) => ({
    ...entry,
    label: entry.ownVote
      ? itemVoteNeedsLabel(entry.label, row.title, ownInForce)
        ? (entry.label ?? t("controlSheet.itemVotes.fallbackQuestion"))
        : null
      : entry.label,
    decidesShown: entry.decides && ownInForce > 1,
  }));
};

/** "Dentro de 14. Resoluciones", in the orders without headings. */
function parentLine(row: GeneralSheetRow): string | null {
  if (!props.flat || !row.parent) return null;
  return t("controlSheet.filters.under", {
    parent: numberedAgendaTitle(
      row.parent.number,
      row.parent.title,
      t("agenda.unlisted.inText"),
    ),
  });
}

const ALL_COLUMNS: { key: GeneralSortKey; label: string; class: string }[] = [
  { key: "number", label: "controlSheet.columns.number", class: "w-24" },
  { key: "item", label: "controlSheet.columns.item", class: "min-w-64" },
  {
    key: "proponent",
    label: "controlSheet.columns.proponent",
    class: "w-28 text-center",
  },
  {
    key: "treated",
    label: "controlSheet.columns.treated",
    class: "w-28 text-center",
  },
  {
    key: "result",
    label: "controlSheet.columns.result",
    class: "w-40 text-center",
  },
  { key: "votes", label: "controlSheet.columns.votes", class: "w-64" },
  { key: "speakers", label: "controlSheet.columns.speakers", class: "w-48" },
];
/** Columns only a sheet key reads. */
const INTERNAL_COLUMNS: ReadonlySet<GeneralSortKey> = new Set(["speakers"]);
const columns = computed(() =>
  props.internal
    ? ALL_COLUMNS
    : ALL_COLUMNS.filter((column) => !INTERNAL_COLUMNS.has(column.key)),
);
/** «Observaciones» or «Mis notas» closes the table, when either is there. */
const notesColumn = computed(() => props.internal || !!props.ownNotes);
/** What a heading spans after its number: every other column. */
const headingSpan = computed(
  () => columns.value.length - 1 + (notesColumn.value ? 1 : 0),
);

/**
 * A click anywhere in an item's row opens its panel, as its button at the
 * start of the row does (E-086: at the end it fell out of view on a laptop),
 * unless it lands on a link, a button or a popover's trigger, or ends a
 * selection.
 */
function openFromRow(event: MouseEvent, row: GeneralSheetRow): void {
  if (row.kind !== "item") return;
  const target = event.target instanceof Element ? event.target : null;
  if (!rowClickOpens(target, window.getSelection()?.toString() ?? "")) return;
  emit("open", row);
}

const itemRows = computed(() =>
  props.rows.filter((row) => row.kind === "item"),
);
</script>

<template>
  <div>
    <!-- Large screens: the table, scrolling sideways inside its own box. -->
    <div
      class="border-default hidden overflow-x-auto rounded-lg border lg:block"
    >
      <table
        :class="[
          'w-full text-left text-sm',
          internal ? 'min-w-[78rem]' : 'min-w-[63rem]',
        ]"
      >
        <caption class="sr-only">
          {{
            t("controlSheet.tabs.general")
          }}
        </caption>
        <thead class="bg-elevated/50 text-muted text-xs">
          <tr>
            <ControlSheetSortHeader
              v-for="column in columns"
              :key="column.key"
              :class="column.class"
              :label="t(column.label)"
              :column="column.key"
              :sort="sort"
              :fallback="DEFAULT_GENERAL_SORT"
              @sort="(key: GeneralSortKey) => emit('sort', key)"
            />
            <th v-if="internal" scope="col" class="w-64 px-3 py-2 font-medium">
              {{ t("controlSheet.columns.observations") }}
            </th>
            <th
              v-else-if="ownNotes"
              scope="col"
              class="w-48 px-3 py-2 font-medium"
            >
              {{ t("notes.title") }}
            </th>
          </tr>
        </thead>
        <tbody class="divide-default divide-y">
          <tr
            v-for="row in rows"
            :key="row.id"
            :aria-current="row.live ? 'true' : undefined"
            :class="[
              'align-top',
              row.kind === 'heading'
                ? 'bg-elevated/30'
                : 'hover:bg-elevated/40 cursor-pointer',
              row.live ? 'ring-primary ring-2 ring-inset' : '',
            ]"
            :data-sheet-row="row.id"
            @click="openFromRow($event, row)"
          >
            <td class="px-3 py-2 font-medium">
              <!-- The way into the row's panel goes first, in view at any
                   width and the row's first stop for the keyboard; the rest
                   of the row opens it too. -->
              <div class="flex items-start gap-1">
                <AgendaItemNumber :number="row.number" />
                <UTooltip v-if="row.kind === 'item'" :text="openButton">
                  <UButton
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    :icon="openIcon"
                    class="-my-0.5 shrink-0"
                    :aria-label="openLabel(row)"
                    @click="emit('open', row)"
                  />
                </UTooltip>
              </div>
            </td>
            <th
              v-if="row.kind === 'heading'"
              scope="row"
              :colspan="headingSpan"
              class="text-highlighted px-3 py-2 font-semibold"
            >
              {{ row.title }}
              <UBadge
                v-if="row.live"
                color="primary"
                variant="subtle"
                size="xs"
                class="ms-1 align-middle"
                :label="t('controlSheet.live')"
              />
            </th>
            <template v-else>
              <th scope="row" class="px-3 py-2 font-normal">
                <p v-if="parentLine(row)" class="text-muted text-xs">
                  {{ parentLine(row) }}
                </p>
                <p class="text-highlighted font-medium">
                  <ULink
                    v-if="ownDocument(row)"
                    :to="documentPath(ownDocument(row)!)"
                    class="underline-offset-2 hover:underline"
                    >{{ row.title }}</ULink
                  >
                  <template v-else>{{ row.title }}</template>
                  <UTooltip
                    v-if="ownDocument(row)"
                    :text="t('controlSheet.preview.document')"
                  >
                    <UButton
                      color="neutral"
                      variant="ghost"
                      size="xs"
                      icon="i-lucide-scan-eye"
                      class="ms-1 align-middle"
                      :aria-label="previewLabel(ownDocument(row)!)"
                      @click="emit('preview', ownDocument(row)!)"
                    />
                  </UTooltip>
                  <UBadge
                    v-if="row.live"
                    color="primary"
                    variant="subtle"
                    size="xs"
                    class="ms-1 align-middle"
                    :label="t('controlSheet.live')"
                  />
                </p>
                <UButton
                  v-if="ownDocument(row) && amendmentsOf(ownDocument(row)!)"
                  color="primary"
                  variant="link"
                  size="xs"
                  icon="i-lucide-file-pen-line"
                  class="p-0"
                  :label="
                    t(
                      'controlSheet.amendmentCount',
                      { count: amendmentsOf(ownDocument(row)!) },
                      amendmentsOf(ownDocument(row)!),
                    )
                  "
                  :aria-label="
                    t(
                      'controlSheet.openAmendments',
                      {
                        count: amendmentsOf(ownDocument(row)!),
                        title: ownDocument(row)!.title,
                      },
                      amendmentsOf(ownDocument(row)!),
                    )
                  "
                  @click="emit('amendments', ownDocument(row)!)"
                />
                <UBadge
                  v-if="awaitingOf(ownDocument(row))"
                  color="warning"
                  variant="subtle"
                  size="xs"
                  class="ms-2 align-middle"
                  :label="
                    t(
                      'controlSheet.answer.awaiting',
                      { count: awaitingOf(ownDocument(row)) },
                      awaitingOf(ownDocument(row)),
                    )
                  "
                />
                <ul
                  v-if="listedDocuments(row).length > 0"
                  class="mt-1 space-y-0.5"
                >
                  <li
                    v-for="document in listedDocuments(row)"
                    :key="document.id"
                    class="flex flex-wrap items-baseline gap-x-2"
                  >
                    <ULink
                      :to="documentPath(document)"
                      class="text-muted hover:text-default text-xs underline-offset-2 hover:underline"
                    >
                      {{ document.title }}
                    </ULink>
                    <UTooltip :text="t('controlSheet.preview.document')">
                      <UButton
                        color="neutral"
                        variant="ghost"
                        size="xs"
                        icon="i-lucide-scan-eye"
                        class="-my-1 self-center"
                        :aria-label="previewLabel(document)"
                        @click="emit('preview', document)"
                      />
                    </UTooltip>
                    <UButton
                      v-if="amendmentsOf(document)"
                      color="primary"
                      variant="link"
                      size="xs"
                      icon="i-lucide-file-pen-line"
                      class="p-0"
                      :label="
                        t(
                          'controlSheet.amendmentCount',
                          { count: amendmentsOf(document) },
                          amendmentsOf(document),
                        )
                      "
                      :aria-label="
                        t(
                          'controlSheet.openAmendments',
                          {
                            count: amendmentsOf(document),
                            title: document.title,
                          },
                          amendmentsOf(document),
                        )
                      "
                      @click="emit('amendments', document)"
                    />
                    <UBadge
                      v-if="awaitingOf(document)"
                      color="warning"
                      variant="subtle"
                      size="xs"
                      class="self-center"
                      :label="
                        t(
                          'controlSheet.answer.awaiting',
                          { count: awaitingOf(document) },
                          awaitingOf(document),
                        )
                      "
                    />
                  </li>
                </ul>
              </th>
              <td class="px-3 py-2 text-center">
                <ControlSheetProponents
                  :documents="row.documents"
                  :members="members"
                  class="justify-center"
                />
              </td>
              <td class="px-3 py-2 text-center">
                <ControlSheetTreated
                  v-bind="treatedOf(row)"
                  :label="
                    t('controlSheet.treated.item', { title: rowLabel(row) })
                  "
                />
              </td>
              <td class="px-3 py-2 text-center">
                <ControlSheetResultBadge :result="row.outcome.result" />
              </td>
              <td class="space-y-2 px-3 py-2">
                <div v-for="entry in votesOf(row)" :key="entry.id">
                  <ControlSheetVoteLine
                    :vote="entry.vote"
                    :label="entry.label"
                    clamp
                  />
                  <p v-if="entry.decidesShown" class="text-muted text-xs">
                    {{ t("controlSheet.itemVotes.decides") }}
                  </p>
                </div>
                <span
                  v-if="votesOf(row).length === 0"
                  class="text-dimmed text-sm"
                  >{{ t("controlSheet.noVote") }}</span
                >
              </td>
              <td v-if="internal" class="px-3 py-2">
                <ControlSheetSpeakers :speakers="row.speakers" />
              </td>
              <td v-if="notesColumn" class="space-y-2 px-3 py-2">
                <p
                  v-if="internal && row.sheet?.observations"
                  class="text-default line-clamp-3 text-sm whitespace-pre-line"
                >
                  {{ row.sheet.observations }}
                </p>
                <!-- Nothing written: the cell stays empty, said only to
                     screen readers. -->
                <span v-else-if="internal" class="sr-only">{{
                  t("controlSheet.noObservations")
                }}</span>
                <ControlSheetOwnNotes
                  v-if="ownNotes"
                  :lines="notesOf(row)"
                  :clamp="internal ? 2 : 3"
                />
              </td>
            </template>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Below large screens: one card per row, headings as titles. -->
    <ul class="space-y-2 lg:hidden">
      <li
        v-for="row in rows"
        :key="row.id"
        :aria-current="row.live ? 'true' : undefined"
        :data-sheet-row="row.id"
      >
        <p
          v-if="row.kind === 'heading'"
          class="text-highlighted pt-2 text-sm font-semibold"
        >
          <AgendaItemNumber :number="row.number" />
          {{ row.title }}
          <UBadge
            v-if="row.live"
            color="primary"
            variant="subtle"
            size="xs"
            class="ms-1 align-middle"
            :label="t('controlSheet.live')"
          />
        </p>
        <UCard
          v-else
          :ui="{ body: 'space-y-3 p-3 sm:p-4' }"
          :class="row.live ? 'ring-primary ring-2' : ''"
        >
          <div>
            <p v-if="parentLine(row)" class="text-muted text-xs">
              {{ parentLine(row) }}
            </p>
            <p class="text-highlighted font-medium">
              <AgendaItemNumber :number="row.number" />
              <ULink
                v-if="ownDocument(row)"
                :to="documentPath(ownDocument(row)!)"
                class="underline-offset-2 hover:underline"
                >{{ row.title }}</ULink
              >
              <template v-else>{{ row.title }}</template>
              <UTooltip
                v-if="ownDocument(row)"
                :text="t('controlSheet.preview.document')"
              >
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  icon="i-lucide-scan-eye"
                  class="ms-1 align-middle"
                  :aria-label="previewLabel(ownDocument(row)!)"
                  @click="emit('preview', ownDocument(row)!)"
                />
              </UTooltip>
              <UBadge
                v-if="row.live"
                color="primary"
                variant="subtle"
                size="xs"
                class="ms-1 align-middle"
                :label="t('controlSheet.live')"
              />
            </p>
            <UButton
              v-if="ownDocument(row) && amendmentsOf(ownDocument(row)!)"
              color="primary"
              variant="link"
              size="xs"
              icon="i-lucide-file-pen-line"
              class="p-0"
              :label="
                t(
                  'controlSheet.amendmentCount',
                  { count: amendmentsOf(ownDocument(row)!) },
                  amendmentsOf(ownDocument(row)!),
                )
              "
              :aria-label="
                t(
                  'controlSheet.openAmendments',
                  {
                    count: amendmentsOf(ownDocument(row)!),
                    title: ownDocument(row)!.title,
                  },
                  amendmentsOf(ownDocument(row)!),
                )
              "
              @click="emit('amendments', ownDocument(row)!)"
            />
            <UBadge
              v-if="awaitingOf(ownDocument(row))"
              color="warning"
              variant="subtle"
              size="xs"
              class="ms-2 align-middle"
              :label="
                t(
                  'controlSheet.answer.awaiting',
                  { count: awaitingOf(ownDocument(row)) },
                  awaitingOf(ownDocument(row)),
                )
              "
            />
            <ul v-if="listedDocuments(row).length > 0" class="mt-1 space-y-0.5">
              <li
                v-for="document in listedDocuments(row)"
                :key="document.id"
                class="flex flex-wrap items-baseline gap-x-2"
              >
                <ULink
                  :to="documentPath(document)"
                  class="text-muted hover:text-default text-xs underline-offset-2 hover:underline"
                >
                  {{ document.title }}
                </ULink>
                <UTooltip :text="t('controlSheet.preview.document')">
                  <UButton
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    icon="i-lucide-scan-eye"
                    class="-my-1 self-center"
                    :aria-label="previewLabel(document)"
                    @click="emit('preview', document)"
                  />
                </UTooltip>
                <UButton
                  v-if="amendmentsOf(document)"
                  color="primary"
                  variant="link"
                  size="xs"
                  icon="i-lucide-file-pen-line"
                  class="p-0"
                  :label="
                    t(
                      'controlSheet.amendmentCount',
                      { count: amendmentsOf(document) },
                      amendmentsOf(document),
                    )
                  "
                  :aria-label="
                    t(
                      'controlSheet.openAmendments',
                      { count: amendmentsOf(document), title: document.title },
                      amendmentsOf(document),
                    )
                  "
                  @click="emit('amendments', document)"
                />
                <UBadge
                  v-if="awaitingOf(document)"
                  color="warning"
                  variant="subtle"
                  size="xs"
                  class="self-center"
                  :label="
                    t(
                      'controlSheet.answer.awaiting',
                      { count: awaitingOf(document) },
                      awaitingOf(document),
                    )
                  "
                />
              </li>
            </ul>
          </div>
          <dl class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div v-if="row.documents.length > 0">
              <dt class="text-muted text-xs">
                {{ t("controlSheet.columns.proponent") }}
              </dt>
              <dd>
                <ControlSheetProponents
                  :documents="row.documents"
                  :members="members"
                />
              </dd>
            </div>
            <div>
              <dt class="text-muted text-xs">
                {{ t("controlSheet.columns.treated") }}
              </dt>
              <dd>
                <ControlSheetTreated
                  v-bind="treatedOf(row)"
                  :label="
                    t('controlSheet.treated.item', { title: rowLabel(row) })
                  "
                />
              </dd>
            </div>
            <div>
              <dt class="text-muted text-xs">
                {{ t("controlSheet.columns.result") }}
              </dt>
              <dd><ControlSheetResultBadge :result="row.outcome.result" /></dd>
            </div>
            <div class="sm:col-span-2">
              <dt class="text-muted text-xs">
                {{ t("controlSheet.columns.votes") }}
              </dt>
              <dd class="space-y-2">
                <div v-for="entry in votesOf(row)" :key="entry.id">
                  <ControlSheetVoteLine
                    :vote="entry.vote"
                    :label="entry.label"
                    clamp
                  />
                  <p v-if="entry.decidesShown" class="text-muted text-xs">
                    {{ t("controlSheet.itemVotes.decides") }}
                  </p>
                </div>
                <span
                  v-if="votesOf(row).length === 0"
                  class="text-dimmed text-sm"
                  >{{ t("controlSheet.noVote") }}</span
                >
              </dd>
            </div>
            <div v-if="internal" class="sm:col-span-2">
              <dt class="text-muted text-xs">
                {{ t("controlSheet.columns.speakers") }}
              </dt>
              <dd><ControlSheetSpeakers :speakers="row.speakers" /></dd>
            </div>
            <div
              v-if="internal && row.sheet?.observations"
              class="sm:col-span-2"
            >
              <dt class="text-muted text-xs">
                {{ t("controlSheet.columns.observations") }}
              </dt>
              <dd class="text-default line-clamp-4 text-sm whitespace-pre-line">
                {{ row.sheet.observations }}
              </dd>
            </div>
            <div
              v-if="ownNotes && notesOf(row).length > 0"
              class="sm:col-span-2"
            >
              <dt class="text-muted text-xs">
                {{ t("notes.title") }}
              </dt>
              <dd>
                <ControlSheetOwnNotes :lines="notesOf(row)" :clamp="4" />
              </dd>
            </div>
          </dl>
          <UButton
            color="neutral"
            variant="outline"
            size="sm"
            :icon="openIcon"
            :label="openButton"
            :aria-label="openLabel(row)"
            @click="emit('open', row)"
          />
        </UCard>
      </li>
    </ul>
    <p class="sr-only">
      {{
        t("controlSheet.rowCount", { count: itemRows.length }, itemRows.length)
      }}
    </p>
  </div>
</template>
