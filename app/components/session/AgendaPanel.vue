<script setup lang="ts">
import type { DocumentSummaryDto } from "~~/shared/types/api";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";
import { scrollParentOf } from "~/utils/scrollAnchor";
import { revealIn } from "./-reveal";

/**
 * Agenda progress: every item with its documents. "Debate" points the live
 * state (and the projection) at an item or a document; selecting a document
 * only changes what the console shows. An item reads treated (a check) by
 * the control sheet's own rule (the server's sessionTreatedItems: its
 * votes, a result by hand, the Mesa's mark, which presenting it sets, or
 * all its items treated); a document reads «Proyectado» once on screen and
 * «Tratado» once its own item is, and a treated one dims. For the Mesa the
 * check of an item treated only by its mark is a button that undoes it, and
 * the circle of one neither treated nor waiting for a vote marks it (user's
 * decision of 2026-11-19). A mark left on an item now waiting for a vote
 * counts for nothing: a faint check, which undoes it too.
 *
 * With `follow` (the side column, a box of its own), the item in debate is
 * kept in view as the debate moves while the agenda is in view there
 * (E-078; the strip's icon opens it at that item): only that box scrolls,
 * never the page, so the phone's single column never jumps to the agenda.
 */
const props = defineProps<{ follow?: boolean }>();

const session = useSessionConsoleContext();
const { t } = useI18n();

const rows = computed(() => session.agendaRows.value);
// What this console debates: the projection with control, else its own.
const liveItemId = computed(() => session.debate.value?.agendaItemId ?? null);
const liveDocumentId = computed(() => session.debate.value?.documentId ?? null);

const documents = computed(() => rows.value.flatMap((row) => row.documents));
const votable = computed(() =>
  documents.value.filter((document) => document.voted),
);
// A text approved pending conciliation is not final yet (user's decisions
// of 2026-11-21).
const finished = computed(
  () =>
    votable.value.filter(
      (document) => document.consolidated && document.pendingConciliation === 0,
    ).length,
);

const loading = computed(
  () => !session.agenda.value && session.agendaStatus.value === "pending",
);
const failed = computed(
  () => Boolean(session.agendaError.value) && !session.agenda.value,
);

const list = ref<HTMLElement | null>(null);
// The column is one scroll shared with the turns: it follows only while
// the agenda is in view there, never pulling the turns away.
watch(
  liveItemId,
  (id) => {
    if (!props.follow || !id || !list.value) return;
    const row = list.value.querySelector<HTMLElement>('[aria-current="step"]');
    const box = row ? scrollParentOf(row) : null;
    if (!row || !box) return;
    const view = box.getBoundingClientRect();
    const agenda = list.value.getBoundingClientRect();
    if (agenda.bottom <= view.top || agenda.top >= view.bottom) return;
    revealIn(box, row);
  },
  { flush: "post" },
);

function select(document: DocumentSummaryDto): void {
  session.documentId.value = document.id;
}

function itemDone(documents: DocumentSummaryDto[]): boolean {
  const voted = documents.filter((document) => document.voted);
  return voted.length > 0 && voted.every((document) => document.consolidated);
}

function itemTreated(row: {
  item: { id: string };
  documents: DocumentSummaryDto[];
}): boolean {
  return (
    itemDone(row.documents) || session.treatedItemIds.value.has(row.item.id)
  );
}

/**
 * A mark the Mesa set before the item came to wait for a vote: it counts
 * for nothing meanwhile, but the Mesa can still take it away.
 */
function staleMark(row: { item: { id: string } }, treated: boolean): boolean {
  if (treated) return false;
  const entry = session.itemTreatment(row.item.id);
  return Boolean(entry?.awaitingVote && entry.marked);
}

function statusIcon(row: { item: { id: string } }, treated: boolean): string {
  if (treated || staleMark(row, treated)) return "i-lucide-circle-check";
  return liveItemId.value === row.item.id
    ? "i-lucide-circle-dot"
    : "i-lucide-circle";
}

function statusColor(row: { item: { id: string } }, treated: boolean): string {
  if (treated) return "text-success";
  if (staleMark(row, treated)) return "text-dimmed";
  return liveItemId.value === row.item.id ? "text-primary" : "text-dimmed";
}
</script>

<template>
  <div class="space-y-3">
    <div v-if="loading" class="space-y-2" role="status">
      <span class="sr-only">{{ t("agenda.loading") }}</span>
      <USkeleton
        v-for="n in 6"
        :key="n"
        aria-hidden="true"
        class="h-10 w-full"
      />
    </div>
    <UAlert
      v-else-if="failed"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :title="t('session.agenda.error')"
    />
    <CommonEmptyState
      v-else-if="rows.length === 0"
      icon="i-lucide-list-tree"
      size="sm"
      :title="t('session.agenda.empty')"
    />
    <template v-else>
      <div v-if="votable.length > 0" class="space-y-1">
        <p class="text-muted text-xs">
          {{
            t("session.agenda.progress", {
              done: finished,
              total: votable.length,
            })
          }}
        </p>
        <UProgress
          :model-value="finished"
          :max="votable.length"
          size="sm"
          :aria-label="t('session.agenda.progressLabel')"
        />
      </div>

      <ol ref="list" class="space-y-1" :aria-label="t('session.agenda.title')">
        <li
          v-for="row in rows"
          :key="row.item.id"
          :style="{ paddingInlineStart: `${row.depth * 0.75}rem` }"
        >
          <div
            class="group flex items-start gap-2 rounded-md px-2 py-1.5"
            :class="
              liveItemId === row.item.id
                ? 'bg-primary/10 ring-primary/40 ring-1'
                : ''
            "
            :aria-current="liveItemId === row.item.id ? 'step' : undefined"
          >
            <!-- The Mesa's mark, undone (or set) from its own icon. -->
            <UTooltip
              v-if="session.itemMarkAction(row.item.id)"
              :text="
                staleMark(row, itemTreated(row))
                  ? t('session.progress.staleMarkHint')
                  : session.itemMarkAction(row.item.id) === 'unmark'
                    ? t('session.progress.markedHint')
                    : t('session.progress.markHint')
              "
            >
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                square
                class="-mx-1 -my-0.5 shrink-0 p-0.5"
                :aria-label="
                  staleMark(row, itemTreated(row))
                    ? t('session.progress.unmarkStaleItem', {
                        title: row.item.title,
                      })
                    : session.itemMarkAction(row.item.id) === 'unmark'
                      ? t('session.progress.unmarkItem', {
                          title: row.item.title,
                        })
                      : t('session.progress.markItem', {
                          title: row.item.title,
                        })
                "
                :aria-pressed="
                  itemTreated(row) || staleMark(row, itemTreated(row))
                "
                :disabled="
                  Boolean(session.busy.value[`treated-${row.item.id}`])
                "
                @click="
                  session.setItemTreated(
                    row.item.id,
                    session.itemMarkAction(row.item.id) === 'mark',
                  )
                "
              >
                <UIcon
                  :name="statusIcon(row, itemTreated(row))"
                  class="size-4"
                  :class="statusColor(row, itemTreated(row))"
                  aria-hidden="true"
                />
              </UButton>
            </UTooltip>
            <UIcon
              v-else
              :name="statusIcon(row, itemTreated(row))"
              class="mt-0.5 size-4 shrink-0"
              :class="statusColor(row, itemTreated(row))"
              aria-hidden="true"
            />
            <span
              class="min-w-0 flex-1 text-sm font-medium"
              :class="
                itemTreated(row) && liveItemId !== row.item.id
                  ? 'text-muted'
                  : 'text-highlighted'
              "
            >
              <AgendaItemNumber :number="row.number" class="text-muted" />
              {{ row.item.title }}
              <span v-if="itemTreated(row)" class="sr-only">
                · {{ t("session.progress.treated") }}
              </span>
            </span>
            <!-- Its own tooltip and icon: it must not pass for the button
                 of a document with the same title. -->
            <UTooltip :text="t('session.agenda.debateItemShort')">
              <!-- 24 px on a 20 px first line: centred on it. -->
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                icon="i-lucide-list-tree"
                class="-my-0.5 shrink-0"
                :aria-label="
                  t('session.agenda.debateItem', { title: row.item.title })
                "
                :disabled="
                  !session.inSession.value ||
                  (liveItemId === row.item.id && !liveDocumentId)
                "
                @click="session.debateAgendaItem(row.item.id)"
              />
            </UTooltip>
          </div>

          <ul v-if="row.documents.length > 0" class="mt-1 space-y-1 ps-6">
            <li v-for="document in row.documents" :key="document.id">
              <div
                class="flex items-start gap-1 rounded-md border px-2 py-1.5"
                :class="[
                  session.documentId.value === document.id
                    ? 'border-primary/60 bg-elevated'
                    : 'border-transparent',
                  liveDocumentId === document.id ? 'bg-primary/5' : '',
                ]"
              >
                <!-- Two lines of title, the rest on hover: two certificates
                     must not read the same (E-075). -->
                <button
                  type="button"
                  class="focus-visible:ring-primary min-w-0 flex-1 rounded text-start text-sm outline-none focus-visible:ring-2"
                  :title="document.title"
                  :aria-pressed="session.documentId.value === document.id"
                  @click="select(document)"
                >
                  <span
                    class="line-clamp-2 break-words"
                    :class="
                      session.documentProgress(document.id) === 'treated' &&
                      liveDocumentId !== document.id
                        ? 'text-muted'
                        : 'text-default'
                    "
                  >
                    {{ document.title }}
                  </span>
                  <span
                    class="text-muted flex flex-wrap items-center gap-x-2 text-xs"
                  >
                    <span v-if="document.reference">{{
                      document.reference
                    }}</span>
                    <span v-if="document.amendable">
                      {{
                        t(
                          "session.agenda.amendments",
                          { count: document.amendmentCount },
                          document.amendmentCount,
                        )
                      }}
                    </span>
                    <span
                      v-if="
                        document.consolidated &&
                        document.pendingConciliation > 0
                      "
                      class="text-warning"
                    >
                      {{ t("document.pendingConciliation.status") }}
                    </span>
                    <span
                      v-else-if="document.consolidated"
                      class="text-success"
                    >
                      {{ t("session.agenda.final") }}
                    </span>
                    <span
                      v-else-if="liveDocumentId === document.id"
                      class="text-primary font-medium"
                    >
                      {{ t("session.agenda.inDebate") }}
                    </span>
                    <SessionProgressMark
                      v-if="
                        !document.consolidated && liveDocumentId !== document.id
                      "
                      :progress="session.documentProgress(document.id)"
                    />
                  </span>
                </button>
                <UTooltip :text="t('session.agenda.debateDocument')">
                  <UButton
                    size="xs"
                    class="-my-0.5 shrink-0"
                    :color="
                      liveDocumentId === document.id ? 'primary' : 'neutral'
                    "
                    :variant="liveDocumentId === document.id ? 'soft' : 'ghost'"
                    icon="i-lucide-radio"
                    :aria-label="
                      t('session.agenda.debateDocumentNamed', {
                        title: document.title,
                      })
                    "
                    :disabled="!session.inSession.value"
                    @click="session.debateDocument(document)"
                  />
                </UTooltip>
              </div>
            </li>
          </ul>
        </li>
      </ol>
    </template>
  </div>
</template>
