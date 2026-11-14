<script setup lang="ts">
import type { AmendmentDto, MemberRef } from "~~/shared/types/api";
import { LIVE_STATE_COLORS } from "~/components/live-view/-model";
import type { AmendmentSheetRow } from "./-model";

/**
 * «Enmiendas» of the control sheet for one document: its amendments in the
 * console's order, with who presents each, the presenter's answer (when
 * the reader may see it), whether it was treated, its result and its vote.
 * A table on large screens, a card per amendment below them.
 */
const props = defineProps<{
  rows: AmendmentSheetRow[];
  amendmentPath: (amendment: AmendmentDto) => string;
}>();
const emit = defineEmits<{ open: [row: AmendmentSheetRow] }>();

const { t } = useI18n();

/** The main author first, then the rest by acronym. */
function authorsOf(amendment: AmendmentDto): string {
  const authors: MemberRef[] = [...amendment.authors].sort((a, b) => {
    if (a.id === amendment.mainAuthorId) return -1;
    if (b.id === amendment.mainAuthorId) return 1;
    return a.acronym.localeCompare(b.acronym);
  });
  return authors.map((author) => author.acronym).join(", ");
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
            <th scope="col" class="w-24 px-3 py-2 font-medium">
              {{ t("controlSheet.columns.code") }}
            </th>
            <th scope="col" class="w-32 px-3 py-2 font-medium">
              {{ t("controlSheet.columns.authors") }}
            </th>
            <th scope="col" class="w-32 px-3 py-2 font-medium">
              {{ t("controlSheet.columns.ceaPosition") }}
            </th>
            <th scope="col" class="w-44 px-3 py-2 font-medium">
              {{ t("controlSheet.columns.position") }}
            </th>
            <th scope="col" class="w-28 px-3 py-2 font-medium">
              {{ t("controlSheet.columns.treated") }}
            </th>
            <th scope="col" class="min-w-48 px-3 py-2 font-medium">
              {{ t("controlSheet.columns.result") }}
            </th>
            <th scope="col" class="w-56 px-3 py-2 font-medium">
              {{ t("controlSheet.columns.vote") }}
            </th>
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
            <td class="px-3 py-2">{{ authorsOf(row.amendment) }}</td>
            <td class="px-3 py-2">
              <span
                v-if="row.sheet?.ceaPosition"
                class="text-default text-sm font-medium"
                >{{ positionLabel(row) }}</span
              >
              <span v-else class="text-dimmed text-sm">{{
                t("controlSheet.ceaPosition.none")
              }}</span>
            </td>
            <td class="px-3 py-2">
              <CommonStatusBadge
                v-if="row.amendment.position"
                kind="position"
                :value="row.amendment.position.position"
                size="xs"
              />
              <span v-else class="text-dimmed text-sm">{{
                t("controlSheet.positionHidden")
              }}</span>
            </td>
            <td class="px-3 py-2">
              <ControlSheetTreated :treated="row.treated" feminine />
            </td>
            <td class="space-y-1 px-3 py-2">
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
                  icon="i-lucide-panel-right-open"
                  class="shrink-0"
                  :aria-label="
                    t('controlSheet.open.amendment', {
                      code: codeOf(row.amendment),
                    })
                  "
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
                {{ t("controlSheet.columns.authors") }}
              </dt>
              <dd class="text-sm">{{ authorsOf(row.amendment) }}</dd>
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
                  v-if="row.amendment.position"
                  kind="position"
                  :value="row.amendment.position.position"
                  size="xs"
                />
                <span v-else class="text-dimmed text-sm">{{
                  t("controlSheet.positionHidden")
                }}</span>
              </dd>
            </div>
            <div>
              <dt class="text-muted text-xs">
                {{ t("controlSheet.columns.treated") }}
              </dt>
              <dd><ControlSheetTreated :treated="row.treated" feminine /></dd>
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
            icon="i-lucide-panel-right-open"
            :label="t('controlSheet.columns.open')"
            :aria-label="
              t('controlSheet.open.amendment', { code: codeOf(row.amendment) })
            "
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
