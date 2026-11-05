<script setup lang="ts">
import {
  LIVE_STATE_COLORS,
  liveAmendmentCode,
  liveAmendmentCounts,
  liveAmendmentNote,
  type LiveAmendmentRow,
} from "~/components/live-view/-model";

/**
 * Where every amendment of the document in debate stands, for the room:
 * a line of counts, then one row per amendment in text order (the one in
 * debate highlighted), each opening the amendment in the document, and the
 * link to the provisional consolidated text.
 */
const props = defineProps<{
  rows: LiveAmendmentRow[];
  /** Localized path of the document workspace. */
  documentPath: string;
  /** Localized path of the consolidated text; null when there is none. */
  consolidatedPath: string | null;
  headingId?: string;
}>();

const { t } = useI18n();

const headingId = computed(() => props.headingId ?? "live-amendments-title");

const counts = computed(() => liveAmendmentCounts(props.rows));

/**
 * A sentence for the states a badge alone does not explain: late, replaced
 * by a transactional (naming it), incorporated without a vote, and what a
 * transactional replaced or still waits for.
 */
function note(row: LiveAmendmentRow): string {
  const found = liveAmendmentNote(row, props.rows);
  return found ? t(found.key, found.params ?? {}) : "";
}

function link(row: LiveAmendmentRow): string {
  return `${props.documentPath}?enmienda=${encodeURIComponent(row.amendment.id)}`;
}

function title(row: LiveAmendmentRow): string {
  const code = liveAmendmentCode(row.amendment);
  return code
    ? t("projection.amendment", { code })
    : t(`session.enums.amendmentKind.${row.amendment.kind}`);
}
</script>

<template>
  <section :aria-labelledby="headingId" class="flex flex-col gap-3">
    <h2 :id="headingId" class="text-highlighted text-lg font-semibold">
      {{ t("liveView.amendments.title") }}
    </h2>

    <p v-if="rows.length === 0" class="text-muted">
      {{ t("liveView.amendments.empty") }}
    </p>

    <template v-else>
      <ul
        class="flex flex-wrap gap-2"
        :aria-label="t('liveView.amendments.summary')"
      >
        <li v-for="entry in counts" :key="entry.state">
          <UBadge
            :color="LIVE_STATE_COLORS[entry.state]"
            variant="subtle"
            size="lg"
            class="tabular-nums"
            :label="
              t(
                `liveView.state.${entry.state}.count`,
                { count: entry.count },
                entry.count,
              )
            "
          />
        </li>
      </ul>

      <ul class="ring-default divide-default divide-y rounded-lg ring">
        <li v-for="row in rows" :key="row.amendment.id">
          <NuxtLink
            :to="link(row)"
            class="hover:bg-elevated/50 focus-visible:outline-primary flex min-h-14 items-center gap-3 px-4 py-3 focus-visible:outline-2 focus-visible:-outline-offset-2"
            :class="
              row.current ? 'bg-primary/10 border-primary border-s-4 ps-3' : ''
            "
            :aria-current="row.current ? 'true' : undefined"
          >
            <div class="min-w-0 flex-1">
              <p
                class="text-highlighted flex flex-wrap items-center gap-x-2 font-semibold"
              >
                <span>{{ title(row) }}</span>
                <span
                  v-if="row.current"
                  class="text-primary text-xs font-semibold uppercase"
                >
                  {{ t("liveView.amendments.inDebate") }}
                </span>
              </p>
              <!--
                Acronyms on screen, full names for screen readers (which would
                spell "CEUM" letter by letter), as CommonMemberBadge does. No
                badges here: the row is already a link.
              -->
              <p
                v-if="row.amendment.authors.length > 0"
                class="text-muted truncate text-sm"
              >
                <span aria-hidden="true">{{
                  row.amendment.authors.map((a) => a.acronym).join(", ")
                }}</span>
                <span class="sr-only">{{
                  row.amendment.authors.map((a) => a.name).join(", ")
                }}</span>
              </p>
              <p v-if="note(row)" class="text-default mt-0.5 text-sm">
                {{ note(row) }}
              </p>
            </div>
            <UBadge
              :color="LIVE_STATE_COLORS[row.state]"
              :variant="row.state === 'debating' ? 'solid' : 'subtle'"
              :label="t(`liveView.state.${row.state}.label`)"
              class="shrink-0 whitespace-nowrap"
            />
            <UIcon
              name="i-lucide-chevron-right"
              class="text-dimmed size-4 shrink-0"
              aria-hidden="true"
            />
          </NuxtLink>
        </li>
      </ul>
    </template>

    <div v-if="consolidatedPath" class="flex flex-col gap-1">
      <UButton
        :to="consolidatedPath"
        icon="i-lucide-file-check-2"
        color="neutral"
        variant="outline"
        size="lg"
        block
        class="sm:w-auto sm:self-start"
        :label="t('liveView.amendments.consolidated')"
      />
      <p class="text-muted text-sm">
        {{ t("liveView.amendments.consolidatedHint") }}
      </p>
    </div>
  </section>
</template>
