<script setup lang="ts">
import type { DocumentSummaryDto } from "~~/shared/types/api";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";

/**
 * Agenda progress: every item with its documents. "Debate" points the live
 * state (and the projection) at an item or a document; selecting a document
 * only changes what the console shows.
 */
const session = useSessionConsoleContext();
const { t } = useI18n();

const rows = computed(() => session.agendaRows.value);
const liveItemId = computed(
  () => session.liveState.value?.agendaItemId ?? null,
);
const liveDocumentId = computed(
  () => session.liveState.value?.documentId ?? null,
);

const documents = computed(() => rows.value.flatMap((row) => row.documents));
const votable = computed(() =>
  documents.value.filter((document) => document.voted),
);
const finished = computed(
  () => votable.value.filter((document) => document.consolidated).length,
);

const loading = computed(
  () => !session.agenda.value && session.agendaStatus.value === "pending",
);
const failed = computed(
  () => Boolean(session.agendaError.value) && !session.agenda.value,
);

function select(document: DocumentSummaryDto): void {
  session.documentId.value = document.id;
}

function itemDone(documents: DocumentSummaryDto[]): boolean {
  const voted = documents.filter((document) => document.voted);
  return voted.length > 0 && voted.every((document) => document.consolidated);
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

      <ol class="space-y-1" :aria-label="t('session.agenda.title')">
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
            <UIcon
              :name="
                itemDone(row.documents)
                  ? 'i-lucide-circle-check'
                  : liveItemId === row.item.id
                    ? 'i-lucide-circle-dot'
                    : 'i-lucide-circle'
              "
              class="mt-0.5 size-4 shrink-0"
              :class="
                itemDone(row.documents)
                  ? 'text-success'
                  : liveItemId === row.item.id
                    ? 'text-primary'
                    : 'text-dimmed'
              "
              aria-hidden="true"
            />
            <span class="text-highlighted min-w-0 flex-1 text-sm font-medium">
              <span class="text-muted tabular-nums">{{ row.number }}.</span>
              {{ row.item.title }}
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
                :disabled="liveItemId === row.item.id && !liveDocumentId"
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
                <button
                  type="button"
                  class="focus-visible:ring-primary min-w-0 flex-1 rounded text-start text-sm outline-none focus-visible:ring-2"
                  :aria-pressed="session.documentId.value === document.id"
                  @click="select(document)"
                >
                  <span class="text-default block truncate">
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
                    <span v-if="document.consolidated" class="text-success">
                      {{ t("session.agenda.final") }}
                    </span>
                    <span
                      v-else-if="liveDocumentId === document.id"
                      class="text-primary font-medium"
                    >
                      {{ t("session.agenda.inDebate") }}
                    </span>
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
