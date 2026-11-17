<script setup lang="ts">
import type { MemberDto } from "~~/shared/types/api";
import {
  DEFAULT_GENERAL_SORT,
  type GeneralSortKey,
  type SheetSort,
} from "./-filters";
import {
  itemTreatedControl,
  rowVoteEntries,
  type GeneralSheetRow,
  type SheetRowDocument,
  type TreatedBox,
} from "./-model";

/**
 * «General» of the control sheet: one row per agenda item it lists, under
 * the items they hang from. A table on large screens, a card per row below
 * them, both with the same fields. The row the Mesa has in debate is
 * marked (aria-current and a ring). «Tratado» only shows here; the Mesa
 * marks it in the row's panel.
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
}>();
const emit = defineEmits<{
  open: [row: GeneralSheetRow];
  sort: [column: GeneralSortKey];
}>();

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

/** "3.1. Title" for the button that opens a row. */
const rowLabel = (row: GeneralSheetRow) =>
  numberedAgendaTitle(row.number, row.title, t("agenda.unlisted.inText"));

const { t } = useI18n();

/**
 * The documents' final votes, or the votes on the item in force (the
 * latest gives the result), each named by its question. With more than one
 * vote on the item in force, the one that gives the result says so
 * (`decidesShown`), as in the panel.
 */
const votesOf = (row: GeneralSheetRow) => {
  const entries = rowVoteEntries(row);
  const ownInForce = entries.filter((entry) => entry.ownVote).length;
  return entries.map((entry) => ({
    ...entry,
    label: entry.ownVote
      ? (entry.label ?? t("controlSheet.itemVotes.fallbackQuestion"))
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

const columns: { key: GeneralSortKey; label: string; class: string }[] = [
  { key: "number", label: "controlSheet.columns.number", class: "w-16" },
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
      <table class="w-full min-w-[78rem] text-left text-sm">
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
            <th scope="col" class="w-64 px-3 py-2 font-medium">
              {{ t("controlSheet.columns.observations") }}
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
              row.kind === 'heading' ? 'bg-elevated/30' : '',
              row.live ? 'ring-primary ring-2 ring-inset' : '',
            ]"
            :data-sheet-row="row.id"
          >
            <td class="px-3 py-2 font-medium">
              <AgendaItemNumber :number="row.number" />
            </td>
            <th
              v-if="row.kind === 'heading'"
              scope="row"
              colspan="7"
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
                  <UBadge
                    v-if="row.live"
                    color="primary"
                    variant="subtle"
                    size="xs"
                    class="ms-1 align-middle"
                    :label="t('controlSheet.live')"
                  />
                </p>
                <ul
                  v-if="listedDocuments(row).length > 0"
                  class="mt-1 space-y-0.5"
                >
                  <li
                    v-for="document in listedDocuments(row)"
                    :key="document.id"
                  >
                    <ULink
                      :to="documentPath(document)"
                      class="text-muted hover:text-default text-xs underline-offset-2 hover:underline"
                    >
                      {{ document.title }}
                    </ULink>
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
              <td class="px-3 py-2">
                <ControlSheetSpeakers :speakers="row.speakers" />
              </td>
              <td class="px-3 py-2">
                <div class="flex items-start justify-between gap-2">
                  <p
                    v-if="row.sheet?.observations"
                    class="text-default line-clamp-3 text-sm whitespace-pre-line"
                  >
                    {{ row.sheet.observations }}
                  </p>
                  <span v-else class="text-dimmed text-sm">{{
                    t("controlSheet.noObservations")
                  }}</span>
                  <UButton
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    :icon="openIcon"
                    class="shrink-0"
                    :aria-label="openLabel(row)"
                    @click="emit('open', row)"
                  />
                </div>
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
              <UBadge
                v-if="row.live"
                color="primary"
                variant="subtle"
                size="xs"
                class="ms-1 align-middle"
                :label="t('controlSheet.live')"
              />
            </p>
            <ul v-if="listedDocuments(row).length > 0" class="mt-1 space-y-0.5">
              <li v-for="document in listedDocuments(row)" :key="document.id">
                <ULink
                  :to="documentPath(document)"
                  class="text-muted hover:text-default text-xs underline-offset-2 hover:underline"
                >
                  {{ document.title }}
                </ULink>
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
            <div class="sm:col-span-2">
              <dt class="text-muted text-xs">
                {{ t("controlSheet.columns.speakers") }}
              </dt>
              <dd><ControlSheetSpeakers :speakers="row.speakers" /></dd>
            </div>
            <div v-if="row.sheet?.observations" class="sm:col-span-2">
              <dt class="text-muted text-xs">
                {{ t("controlSheet.columns.observations") }}
              </dt>
              <dd class="text-default line-clamp-4 text-sm whitespace-pre-line">
                {{ row.sheet.observations }}
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
