<script setup lang="ts">
import type { AmendmentDto, MemberDto, MemberRef } from "~~/shared/types/api";
import { LIVE_STATE_COLORS } from "~/components/live-view/-model";
import {
  DEFAULT_AMENDMENT_SORT,
  type AmendmentSortKey,
  type SheetSort,
} from "./-filters";
import {
  amendmentTreatedControl,
  type AmendmentSheetRow,
  type TreatedBox,
} from "./-model";

/**
 * «Enmiendas» of the control sheet for one document: its amendments in the
 * console's order, with who presents each («Proponente», tags with a card
 * on hover, the main author first), the presenter's answer (when the
 * reader may see it), whether it was treated, its result and its vote. A
 * table on large screens, a card per amendment below them. «Tratada» only
 * shows here; the Mesa marks it in the row's panel. `rows` are the ones
 * the page shows, already filtered and sorted; the headers sort by their
 * column (`sort`).
 */
const props = defineProps<{
  rows: AmendmentSheetRow[];
  amendmentPath: (amendment: AmendmentDto) => string;
  /** Every member by id, for the presenters' cards (empty while loading). */
  members: ReadonlyMap<string, MemberDto>;
  /**
   * The reader edits something in a row's panel (control_sheet:edit or the
   * Mesa): the button that opens it reads «Editar» with a pencil, «Ver» with
   * an eye otherwise.
   */
  canEdit: boolean;
  /**
   * Marks the panel has on their way, by amendment id: the value the box
   * shows meanwhile.
   */
  treatedPending: Readonly<Record<string, boolean>>;
  sort: SheetSort<AmendmentSortKey>;
}>();
const emit = defineEmits<{
  open: [row: AmendmentSheetRow];
  sort: [column: AmendmentSortKey];
}>();

/** The row's box: what is on its way first, then what the sheet says. */
function treatedOf(row: AmendmentSheetRow): TreatedBox {
  const pending = props.treatedPending[row.amendment.id];
  return pending === undefined
    ? { treated: amendmentTreatedControl(row).treated, saving: false }
    : { treated: pending, saving: true };
}

const { t } = useI18n();

/** The main author first, then the rest by acronym. */
/** The main author, then the rest by acronym (shown as «+N»). */
function authorsOf(amendment: AmendmentDto): {
  main: MemberRef[];
  others: MemberRef[];
} {
  const main =
    amendment.authors.find((author) => author.id === amendment.mainAuthorId) ??
    amendment.authors[0];
  return {
    main: main ? [main] : [],
    others: amendment.authors
      .filter((author) => author.id !== main?.id)
      .sort((a, b) => a.acronym.localeCompare(b.acronym)),
  };
}

const openIcon = computed(() =>
  props.canEdit ? "i-lucide-square-pen" : "i-lucide-eye",
);
const openButton = computed(() =>
  props.canEdit
    ? t("controlSheet.edit.button")
    : t("controlSheet.columns.open"),
);
/** «Editar la enmienda UGR1», or «Ver…» for whoever only reads. */
function openLabel(amendment: AmendmentDto): string {
  return t(
    props.canEdit
      ? "controlSheet.edit.amendment"
      : "controlSheet.open.amendment",
    { code: codeOf(amendment) },
  );
}

function codeOf(amendment: AmendmentDto): string {
  return amendment.code ?? t("amendment.unnumberedLabel");
}

/** How it got into the text when no vote was recorded. */
function approvalWithoutVote(amendment: AmendmentDto): string | null {
  if (amendment.outcomeVote || amendment.status !== "approved") return null;
  return amendment.approvalMethod
    ? t(`controlSheet.approval.${amendment.approvalMethod}`)
    : null;
}

const count = computed(() => props.rows.length);

const columns: { key: AmendmentSortKey; label: string; class: string }[] = [
  { key: "code", label: "controlSheet.columns.code", class: "w-24" },
  {
    key: "authors",
    label: "controlSheet.columns.proponent",
    class: "w-32 text-center",
  },
  {
    key: "ceaPosition",
    label: "controlSheet.columns.ceaPosition",
    class: "w-32 text-center",
  },
  {
    key: "position",
    label: "controlSheet.columns.position",
    class: "w-44 text-center",
  },
  {
    key: "treated",
    label: "controlSheet.columns.treated",
    class: "w-28 text-center",
  },
  {
    key: "result",
    label: "controlSheet.columns.result",
    class: "min-w-48 text-center",
  },
  { key: "vote", label: "controlSheet.columns.vote", class: "w-56" },
];

function positionLabel(row: AmendmentSheetRow): string {
  return row.sheet?.ceaPosition
    ? t(`controlSheet.ceaPosition.options.${row.sheet.ceaPosition}`)
    : t("controlSheet.ceaPosition.none");
}
</script>

<template>
  <div>
    <div
      class="border-default hidden overflow-x-auto rounded-lg border lg:block"
    >
      <table class="w-full min-w-[72rem] text-left text-sm">
        <caption class="sr-only">
          {{
            t("controlSheet.tabs.amendments")
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
              :fallback="DEFAULT_AMENDMENT_SORT"
              @sort="(key: AmendmentSortKey) => emit('sort', key)"
            />
            <th scope="col" class="w-56 px-3 py-2 font-medium">
              {{ t("controlSheet.columns.observations") }}
            </th>
          </tr>
        </thead>
        <tbody class="divide-default divide-y">
          <tr
            v-for="row in rows"
            :key="row.amendment.id"
            :aria-current="row.live ? 'true' : undefined"
            :class="[
              'align-top',
              row.live ? 'ring-primary ring-2 ring-inset' : '',
            ]"
            :data-sheet-row="row.amendment.id"
          >
            <th scope="row" class="px-3 py-2 font-medium">
              <ULink
                :to="amendmentPath(row.amendment)"
                class="text-highlighted underline-offset-2 hover:underline"
              >
                {{ codeOf(row.amendment) }}
              </ULink>
            </th>
            <td class="px-3 py-2">
              <ControlSheetMemberTags
                v-bind="authorsOf(row.amendment)"
                :members="members"
                class="justify-center"
              />
            </td>
            <td class="px-3 py-2 text-center">
              <span
                v-if="row.sheet?.ceaPosition"
                class="text-default text-sm font-medium"
                >{{ positionLabel(row) }}</span
              >
              <span v-else class="text-dimmed text-sm">{{
                t("controlSheet.ceaPosition.none")
              }}</span>
            </td>
            <td class="px-3 py-2 text-center">
              <CommonStatusBadge
                v-if="row.position"
                kind="position"
                :value="row.position.position"
              />
              <span v-else class="text-dimmed text-sm">{{
                t("controlSheet.positionNone")
              }}</span>
            </td>
            <td class="px-3 py-2 text-center">
              <ControlSheetTreated
                v-bind="treatedOf(row)"
                :label="
                  t('controlSheet.treated.amendment', {
                    code: codeOf(row.amendment),
                  })
                "
              />
            </td>
            <td class="space-y-1 px-3 py-2 text-center">
              <UBadge
                :color="LIVE_STATE_COLORS[row.state]"
                variant="subtle"
                size="sm"
                class="whitespace-nowrap"
                :label="t(`liveView.state.${row.state}.label`)"
              />
              <p v-if="row.note" class="text-muted text-xs">
                {{ t(row.note.key, row.note.params ?? {}) }}
              </p>
            </td>
            <td class="px-3 py-2">
              <ControlSheetVoteLine
                v-if="row.amendment.outcomeVote"
                :vote="row.amendment.outcomeVote"
              />
              <span
                v-else-if="approvalWithoutVote(row.amendment)"
                class="text-muted text-sm"
                >{{ approvalWithoutVote(row.amendment) }}</span
              >
              <span v-else class="text-dimmed text-sm">{{
                t("controlSheet.noVote")
              }}</span>
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
                  :aria-label="openLabel(row.amendment)"
                  @click="emit('open', row)"
                />
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <ul class="space-y-2 lg:hidden">
      <li
        v-for="row in rows"
        :key="row.amendment.id"
        :aria-current="row.live ? 'true' : undefined"
        :data-sheet-row="row.amendment.id"
      >
        <UCard
          :ui="{ body: 'space-y-3 p-3 sm:p-4' }"
          :class="row.live ? 'ring-primary ring-2' : ''"
        >
          <div class="flex flex-wrap items-center justify-between gap-2">
            <ULink
              :to="amendmentPath(row.amendment)"
              class="text-highlighted font-medium underline-offset-2 hover:underline"
            >
              {{ codeOf(row.amendment) }}
            </ULink>
            <UBadge
              :color="LIVE_STATE_COLORS[row.state]"
              variant="subtle"
              size="sm"
              :label="t(`liveView.state.${row.state}.label`)"
            />
          </div>
          <p v-if="row.note" class="text-muted text-xs">
            {{ t(row.note.key, row.note.params ?? {}) }}
          </p>
          <dl class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <dt class="text-muted text-xs">
                {{ t("controlSheet.columns.proponent") }}
              </dt>
              <dd>
                <ControlSheetMemberTags
                  v-bind="authorsOf(row.amendment)"
                  :members="members"
                />
              </dd>
            </div>
            <div>
              <dt class="text-muted text-xs">
                {{ t("controlSheet.columns.ceaPosition") }}
              </dt>
              <dd class="text-sm">{{ positionLabel(row) }}</dd>
            </div>
            <div>
              <dt class="text-muted text-xs">
                {{ t("controlSheet.columns.position") }}
              </dt>
              <dd>
                <CommonStatusBadge
                  v-if="row.position"
                  kind="position"
                  :value="row.position.position"
                />
                <span v-else class="text-dimmed text-sm">{{
                  t("controlSheet.positionNone")
                }}</span>
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
                    t('controlSheet.treated.amendment', {
                      code: codeOf(row.amendment),
                    })
                  "
                />
              </dd>
            </div>
            <div>
              <dt class="text-muted text-xs">
                {{ t("controlSheet.columns.vote") }}
              </dt>
              <dd>
                <ControlSheetVoteLine
                  v-if="row.amendment.outcomeVote"
                  :vote="row.amendment.outcomeVote"
                />
                <span
                  v-else-if="approvalWithoutVote(row.amendment)"
                  class="text-muted text-sm"
                  >{{ approvalWithoutVote(row.amendment) }}</span
                >
                <span v-else class="text-dimmed text-sm">{{
                  t("controlSheet.noVote")
                }}</span>
              </dd>
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
            :aria-label="openLabel(row.amendment)"
            @click="emit('open', row)"
          />
        </UCard>
      </li>
    </ul>
    <p class="sr-only">
      {{ t("controlSheet.amendmentCount", { count }, count) }}
    </p>
  </div>
</template>
