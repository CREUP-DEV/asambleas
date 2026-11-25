<script setup lang="ts">
import type { AmendmentDto, MemberDto, MemberRef } from "~~/shared/types/api";
import {
  liveNoteMentions,
  type LiveAmendmentState,
} from "~/components/live-view/-model";
import { CONTROL_SHEET_STATE_COLORS } from "~/utils/statusColors";
import {
  DEFAULT_AMENDMENT_SORT,
  type AmendmentSortKey,
  type SheetSort,
} from "./-filters";
import {
  amendmentNoVoteKey,
  amendmentSheetKind,
  amendmentTreatedControl,
  type AmendmentSheetRow,
  type TreatedBox,
} from "./-model";
import { amendmentOwnNotes, type OwnSheetNotes } from "./-readers";
import { rowClickOpens } from "./-rowClick";

/**
 * «Enmiendas» of the control sheet for one document: its amendments in the
 * console's order, with who presents each («Presenta», tags with a card
 * on hover, the main author first), the answer of the document's main
 * presenter (when the reader may see it), whether it was treated (to every
 * reader, user's decision of 2026-11-19), its result and its vote. A table
 * on large screens, a card per amendment below them. «Tratada» only shows
 * here; the Mesa marks it in the row's panel. Each code links to the
 * amendment in its document, and the eye beside it opens it in a floating
 * window without leaving the sheet («Vista previa»). `rows` are the ones
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
  /**
   * A sheet key (ControlSheetDto.can.internal): who spoke and the
   * observations. Without it those columns are not there.
   */
  internal: boolean;
  /**
   * The reader reads the presenter's answers to this document's amendments
   * (with a sheet key, once public, or as its presenter): otherwise the
   * column is not there, so no row reads «Sin respuesta» for an answer it
   * may not read yet.
   */
  showPositions: boolean;
  /**
   * «Mis notas» for a reader without the sheet's key to edit (user's
   * decision of 2026-11-21): the account's own notes; null when the column
   * is not there.
   */
  ownNotes?: OwnSheetNotes | null;
}>();
const emit = defineEmits<{
  open: [row: AmendmentSheetRow];
  sort: [column: AmendmentSortKey];
  /** Read this amendment in a floating window, without leaving the sheet. */
  preview: [row: AmendmentSheetRow];
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
/** «De forma» or «De contenido» (every other kind, CONTENT_AMENDMENT_KINDS). */
const kindOf = amendmentSheetKind;

/**
 * «Tipo» in grey, so it does not read as a council's blue tag: content
 * filled, "de forma" outlined.
 */
const KIND_BADGES = {
  content: { color: "neutral", variant: "subtle" },
  formal: { color: "neutral", variant: "outline" },
} as const;

/**
 * «Pendiente» as in «General», in amber; «Decaído» then in grey, so the
 * two never look alike (CONTROL_SHEET_OVERRIDES).
 */
function stateBadge(state: LiveAmendmentState) {
  return {
    color: CONTROL_SHEET_STATE_COLORS[state],
    variant: "subtle",
  } as const;
}

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

/**
 * The button that opens the row: «Responder» on one waiting for the
 * reader's answer as its document's presenter (user's decision of
 * 2026-11-21), «Editar» or «Ver» otherwise.
 */
function openButtonOf(row: AmendmentSheetRow) {
  if (row.awaitsAnswer) {
    return {
      icon: "i-lucide-reply",
      label: t("controlSheet.answer.button"),
      aria: t("controlSheet.answer.amendment", {
        code: codeOf(row.amendment),
      }),
    };
  }
  return {
    icon: openIcon.value,
    label: openButton.value,
    aria: openLabel(row.amendment),
  };
}

/** «Mis notas» of the row, when the column is there. */
const notesOf = (row: AmendmentSheetRow) =>
  props.ownNotes ? amendmentOwnNotes(row.amendment.id, props.ownNotes) : [];

/** «Vista previa de la enmienda UGR1», for the eye beside its code. */
function previewLabel(amendment: AmendmentDto): string {
  return t("controlSheet.preview.amendmentAria", { code: codeOf(amendment) });
}

function codeOf(amendment: AmendmentDto): string {
  return amendment.code ?? t("amendment.unnumberedLabel");
}

/** «Votación» without a vote recorded: «No aplica» or how it was approved. */
function approvalWithoutVote(amendment: AmendmentDto): string | null {
  const key = amendmentNoVoteKey(amendment);
  return key ? t(key) : null;
}

const count = computed(() => props.rows.length);

const ALL_COLUMNS: { key: AmendmentSortKey; label: string; class: string }[] = [
  { key: "code", label: "controlSheet.columns.code", class: "w-32" },
  {
    key: "authors",
    label: "controlSheet.columns.authors",
    class: "w-32 text-center",
  },
  {
    key: "kind",
    label: "controlSheet.columns.kind",
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
  { key: "speakers", label: "controlSheet.columns.speakers", class: "w-44" },
];
/** Columns only a sheet key reads. */
const INTERNAL_COLUMNS: ReadonlySet<AmendmentSortKey> = new Set(["speakers"]);
const columns = computed(() =>
  ALL_COLUMNS.filter(
    (column) =>
      (props.internal || !INTERNAL_COLUMNS.has(column.key)) &&
      (props.showPositions || column.key !== "position"),
  ),
);
/** «Observaciones» or «Mis notas» closes the table, when either is there. */
const notesColumn = computed(() => props.internal || !!props.ownNotes);

/**
 * A click anywhere in a row opens its panel, as its button beside the code
 * does (E-086: at the end it fell out of view on a laptop), unless it lands
 * on a link, a button or a popover's trigger, or ends a selection.
 */
function openFromRow(event: MouseEvent, row: AmendmentSheetRow): void {
  const target = event.target instanceof Element ? event.target : null;
  if (!rowClickOpens(target, window.getSelection()?.toString() ?? "")) return;
  emit("open", row);
}
</script>

<template>
  <div>
    <!-- Positioned, so the sr-only texts of its cells stay inside the box
         that scrolls sideways and never widen the page (E-087). -->
    <div
      class="border-default relative hidden overflow-x-auto rounded-lg border lg:block"
    >
      <table
        :class="[
          'w-full text-left text-sm',
          internal ? 'min-w-[72rem]' : 'min-w-[59rem]',
        ]"
      >
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
            <th v-if="internal" scope="col" class="w-56 px-3 py-2 font-medium">
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
            :key="row.amendment.id"
            :aria-current="row.live ? 'true' : undefined"
            :class="[
              'hover:bg-elevated/40 cursor-pointer align-top',
              row.live ? 'ring-primary ring-2 ring-inset' : '',
            ]"
            :data-sheet-row="row.amendment.id"
            @click="openFromRow($event, row)"
          >
            <th scope="row" class="px-3 py-2 font-medium">
              <!-- The way into the row's panel sits by its code, in view at
                   any width: the pencil or the eye first, or «Responder»
                   under the code on one waiting for the reader's answer as
                   its presenter. The rest of the row opens it too. -->
              <span class="inline-flex items-center gap-1">
                <UTooltip v-if="!row.awaitsAnswer" :text="openButton">
                  <UButton
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    :icon="openIcon"
                    class="-my-1 shrink-0"
                    :aria-label="openLabel(row.amendment)"
                    @click="emit('open', row)"
                  />
                </UTooltip>
                <ULink
                  :to="amendmentPath(row.amendment)"
                  class="text-highlighted underline-offset-2 hover:underline"
                >
                  {{ codeOf(row.amendment) }}
                </ULink>
                <UTooltip :text="t('controlSheet.preview.document')">
                  <UButton
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    icon="i-lucide-scan-eye"
                    class="-my-1"
                    :aria-label="previewLabel(row.amendment)"
                    @click="emit('preview', row)"
                  />
                </UTooltip>
              </span>
              <UButton
                v-if="row.awaitsAnswer"
                color="primary"
                variant="soft"
                size="xs"
                :icon="openButtonOf(row).icon"
                :label="openButtonOf(row).label"
                class="mt-1 flex w-fit"
                :aria-label="openButtonOf(row).aria"
                @click="emit('open', row)"
              />
            </th>
            <td class="px-3 py-2">
              <ControlSheetMemberTags
                v-bind="authorsOf(row.amendment)"
                :members="members"
                :label="t('controlSheet.columns.authors')"
                :others-title="t('controlSheet.otherAuthors')"
                class="justify-center"
              />
            </td>
            <td class="px-3 py-2 text-center">
              <UBadge
                v-bind="KIND_BADGES[kindOf(row.amendment)]"
                size="md"
                class="whitespace-nowrap"
                :label="t(`controlSheet.kind.${kindOf(row.amendment)}`)"
              />
            </td>
            <td v-if="showPositions" class="px-3 py-2 text-center">
              <UBadge
                v-if="row.awaitsAnswer"
                color="warning"
                variant="subtle"
                size="md"
                :label="t('controlSheet.answer.pending')"
              />
              <CommonStatusBadge
                v-else-if="row.position"
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
                v-bind="stateBadge(row.state)"
                size="md"
                class="whitespace-nowrap"
                :label="t(`liveView.state.${row.state}.label`)"
              />
              <p v-if="row.note" class="text-muted text-xs">
                <AmendmentLinkedText
                  :text="t(row.note.key, row.note.params ?? {})"
                  :ids="liveNoteMentions(row.amendment)"
                />
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
            <span class="inline-flex items-center gap-1">
              <ULink
                :to="amendmentPath(row.amendment)"
                class="text-highlighted font-medium underline-offset-2 hover:underline"
              >
                {{ codeOf(row.amendment) }}
              </ULink>
              <UTooltip :text="t('controlSheet.preview.document')">
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  icon="i-lucide-scan-eye"
                  class="-my-1"
                  :aria-label="previewLabel(row.amendment)"
                  @click="emit('preview', row)"
                />
              </UTooltip>
            </span>
            <UBadge
              v-bind="stateBadge(row.state)"
              size="md"
              :label="t(`liveView.state.${row.state}.label`)"
            />
          </div>
          <p v-if="row.note" class="text-muted text-xs">
            <AmendmentLinkedText
              :text="t(row.note.key, row.note.params ?? {})"
              :ids="liveNoteMentions(row.amendment)"
            />
          </p>
          <dl class="grid grid-cols-2 gap-2">
            <div>
              <dt class="text-muted text-xs">
                {{ t("controlSheet.columns.authors") }}
              </dt>
              <dd>
                <ControlSheetMemberTags
                  v-bind="authorsOf(row.amendment)"
                  :members="members"
                  :label="t('controlSheet.columns.authors')"
                  :others-title="t('controlSheet.otherAuthors')"
                />
              </dd>
            </div>
            <div>
              <dt class="text-muted text-xs">
                {{ t("controlSheet.columns.kind") }}
              </dt>
              <dd>
                <UBadge
                  v-bind="KIND_BADGES[kindOf(row.amendment)]"
                  size="md"
                  :label="t(`controlSheet.kind.${kindOf(row.amendment)}`)"
                />
              </dd>
            </div>
            <!-- The whole width: an answer («Propone una transaccional»)
                 does not fit half a phone's card. -->
            <div v-if="showPositions" class="col-span-2">
              <dt class="text-muted text-xs">
                {{ t("controlSheet.columns.position") }}
              </dt>
              <dd>
                <UBadge
                  v-if="row.awaitsAnswer"
                  color="warning"
                  variant="subtle"
                  size="md"
                  :label="t('controlSheet.answer.pending')"
                />
                <CommonStatusBadge
                  v-else-if="row.position"
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
            <div class="col-span-2">
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
            <div v-if="internal && row.speakers.length > 0" class="col-span-2">
              <dt class="text-muted text-xs">
                {{ t("controlSheet.columns.speakers") }}
              </dt>
              <dd>
                <ControlSheetSpeakers :speakers="row.speakers" />
              </dd>
            </div>
            <div v-if="internal && row.sheet?.observations" class="col-span-2">
              <dt class="text-muted text-xs">
                {{ t("controlSheet.columns.observations") }}
              </dt>
              <dd class="text-default line-clamp-4 text-sm whitespace-pre-line">
                {{ row.sheet.observations }}
              </dd>
            </div>
            <div v-if="ownNotes && notesOf(row).length > 0" class="col-span-2">
              <dt class="text-muted text-xs">
                {{ t("notes.title") }}
              </dt>
              <dd>
                <ControlSheetOwnNotes :lines="notesOf(row)" :clamp="4" />
              </dd>
            </div>
          </dl>
          <UButton
            :color="row.awaitsAnswer ? 'primary' : 'neutral'"
            :variant="row.awaitsAnswer ? 'soft' : 'outline'"
            size="sm"
            :icon="openButtonOf(row).icon"
            :label="openButtonOf(row).label"
            :aria-label="openButtonOf(row).aria"
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
