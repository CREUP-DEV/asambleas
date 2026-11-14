<script setup lang="ts">
import type { GeneralSheetRow, SheetRowDocument } from "./-model";

/**
 * «General» of the control sheet: one row per agenda item it lists, under
 * the items they hang from. A table on large screens, a card per row below
 * them, both with the same fields. The row the Mesa has in debate is
 * marked (aria-current and a ring).
 */
const props = defineProps<{
  rows: GeneralSheetRow[];
  documentPath: (document: SheetRowDocument) => string;
}>();
const emit = defineEmits<{ open: [row: GeneralSheetRow] }>();

/** "3.1. Title" for the button that opens a row. */
const rowLabel = (row: GeneralSheetRow) =>
  numberedAgendaTitle(row.number, row.title, t("agenda.unlisted.inText"));

const { t } = useI18n();

const votesOf = (row: GeneralSheetRow) =>
  row.documents
    .filter((document) => document.finalVote)
    .map((document) => ({
      id: document.id,
      vote: document.finalVote!,
      label:
        row.documents.filter((other) => other.finalVote).length > 1
          ? (document.reference ?? document.title)
          : null,
    }));

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
      <table class="w-full min-w-[72rem] text-left text-sm">
        <caption class="sr-only">
          {{
            t("controlSheet.tabs.general")
          }}
        </caption>
        <thead class="bg-elevated/50 text-muted text-xs">
          <tr>
            <th scope="col" class="w-16 px-3 py-2 font-medium">
              {{ t("controlSheet.columns.number") }}
            </th>
            <th scope="col" class="min-w-64 px-3 py-2 font-medium">
              {{ t("controlSheet.columns.item") }}
            </th>
            <th scope="col" class="w-28 px-3 py-2 font-medium">
              {{ t("controlSheet.columns.treated") }}
            </th>
            <th scope="col" class="w-40 px-3 py-2 font-medium">
              {{ t("controlSheet.columns.result") }}
            </th>
            <th scope="col" class="w-64 px-3 py-2 font-medium">
              {{ t("controlSheet.columns.votes") }}
            </th>
            <th scope="col" class="w-48 px-3 py-2 font-medium">
              {{ t("controlSheet.columns.speakers") }}
            </th>
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
              colspan="6"
              class="text-highlighted px-3 py-2 font-semibold"
            >
              {{ row.title }}
            </th>
            <template v-else>
              <th scope="row" class="px-3 py-2 font-normal">
                <p class="text-highlighted font-medium">
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
                <ul v-if="row.documents.length > 0" class="mt-1 space-y-0.5">
                  <li v-for="document in row.documents" :key="document.id">
                    <ULink
                      :to="documentPath(document)"
                      class="text-muted hover:text-default text-xs underline-offset-2 hover:underline"
                    >
                      {{ document.reference ?? document.title }}
                    </ULink>
                  </li>
                </ul>
              </th>
              <td class="px-3 py-2">
                <ControlSheetTreated :treated="row.outcome.treated" />
              </td>
              <td class="px-3 py-2">
                <ControlSheetResultBadge :result="row.outcome.result" />
              </td>
              <td class="space-y-2 px-3 py-2">
                <ControlSheetVoteLine
                  v-for="entry in votesOf(row)"
                  :key="entry.id"
                  :vote="entry.vote"
                  :label="entry.label"
                />
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
                    icon="i-lucide-panel-right-open"
                    class="shrink-0"
                    :aria-label="
                      t('controlSheet.open.item', { title: rowLabel(row) })
                    "
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
        </p>
        <UCard
          v-else
          :ui="{ body: 'space-y-3 p-3 sm:p-4' }"
          :class="row.live ? 'ring-primary ring-2' : ''"
        >
          <div>
            <p class="text-highlighted font-medium">
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
            <ul v-if="row.documents.length > 0" class="mt-1 space-y-0.5">
              <li v-for="document in row.documents" :key="document.id">
                <ULink
                  :to="documentPath(document)"
                  class="text-muted hover:text-default text-xs underline-offset-2 hover:underline"
                >
                  {{ document.reference ?? document.title }}
                </ULink>
              </li>
            </ul>
          </div>
          <dl class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <dt class="text-muted text-xs">
                {{ t("controlSheet.columns.treated") }}
              </dt>
              <dd><ControlSheetTreated :treated="row.outcome.treated" /></dd>
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
                <ControlSheetVoteLine
                  v-for="entry in votesOf(row)"
                  :key="entry.id"
                  :vote="entry.vote"
                  :label="entry.label"
                />
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
            icon="i-lucide-panel-right-open"
            :label="t('controlSheet.columns.open')"
            :aria-label="t('controlSheet.open.item', { title: rowLabel(row) })"
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
