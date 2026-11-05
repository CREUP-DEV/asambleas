<script setup lang="ts">
import type { DocumentSummaryDto } from "~~/shared/types/api";
import { isSessionOpen } from "~/composables/session/sessionModel";
import { useFinalVoteReasonText } from "~/composables/session/useFinalVoteReasonText";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";
import { useSessionStageLabel } from "~/composables/session/useSessionStageLabel";

/**
 * "Ahora en debate": what the room is debating now, in large type, with
 * where it stands and the next step as one primary action. It follows the
 * live state, so every Mesa device shows the same thing:
 *
 * - nothing yet: start with the first agenda item;
 * - an agenda item: its documents, or the next item;
 * - a document: start with (or go on to) the next amendment the Mesa can
 *   decide, then the final vote, then the next item;
 * - an amendment: its change and the actions that fit (NowAmendment).
 *
 * When this device is looking at another document than the one in debate,
 * it says so and offers to go back.
 *
 * One region that is always there tells screen readers what is debated now
 * and where it stands, so a change made from another Mesa device is
 * announced too (a region inserted with its content usually is not).
 */
const session = useSessionConsoleContext();
const { t } = useI18n();

const live = computed(() => session.liveState.value);
const liveBusy = computed(() => Boolean(session.busy.value.live));

const liveRow = computed(() => {
  const id = live.value?.agendaItemId;
  return id
    ? (session.agendaRows.value.find((row) => row.item.id === id) ?? null)
    : null;
});
const liveDocumentSummary = computed<DocumentSummaryDto | null>(() => {
  const id = live.value?.documentId;
  if (!id) return null;
  for (const row of session.agendaRows.value) {
    const found = row.documents.find((document) => document.id === id);
    if (found) return found;
  }
  return null;
});

type Mode =
  "loading" | "idle" | "elsewhere" | "amendment" | "document" | "item";

const mode = computed<Mode>(() => {
  const state = live.value;
  if (!state) {
    return session.liveStatus.value === "pending" ? "loading" : "idle";
  }
  if (state.documentId && !session.showingLiveDocument.value) {
    return "elsewhere";
  }
  if (state.amendmentId && state.documentId) return "amendment";
  if (state.documentId) return "document";
  if (state.agendaItemId) return "item";
  return "idle";
});

/** The context line above the headline: agenda item and document. */
const context = computed(() =>
  [
    liveRow.value
      ? `${liveRow.value.number}. ${liveRow.value.item.title}`
      : null,
    mode.value === "amendment" || mode.value === "elsewhere"
      ? (liveDocumentSummary.value?.reference ??
        liveDocumentSummary.value?.title ??
        null)
      : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" › "),
);

const nextAgenda = computed(() => session.nextAgendaTarget.value);
const nextAgendaLabel = computed(() =>
  nextAgenda.value
    ? `${nextAgenda.value.row.number}. ${nextAgenda.value.row.item.title}`
    : "",
);

// Document under debate ------------------------------------------------------------

const document = computed(() => session.document.value ?? null);
const amendmentsLoaded = computed(() => Boolean(session.amendmentsDto.value));
const next = computed(() => session.nextAmendment.value);
const lateCount = computed(() => session.queue.value.pending.length);
/** Amendments the Mesa can still decide (validated and admitted). */
const undecidedOpen = computed(
  () => session.amendments.value.filter(isSessionOpen).length,
);
const reasonText = useFinalVoteReasonText(session.label);
const finalVote = computed(() => document.value?.finalVote ?? null);
const finalVoteReasons = computed(() =>
  session.finalVoteReasons.value
    // The status sentence already says it when the text is not voted.
    .filter(
      (reason) =>
        reason.key !== "amendmentsLoading" && reason.key !== "notVoted",
    )
    .map(reasonText),
);
const finalVoteReady = computed(
  () =>
    Boolean(document.value?.can.moderate) &&
    !finalVote.value &&
    session.finalVoteReasons.value.length === 0,
);

/** The one sentence that says where the document stands. */
const documentStatus = computed(() => {
  const current = document.value;
  if (!current) return null;
  if (finalVote.value) {
    return finalVote.value.result === "approved"
      ? t("session.preview.finalApproved")
      : t("session.preview.finalRejected");
  }
  if (!current.amendable || current.format === "file") {
    return current.voted
      ? t("session.now.document.notAmendable")
      : t("session.now.document.notVoted");
  }
  if (next.value) {
    return t(
      "session.now.document.undecided",
      { count: undecidedOpen.value },
      undecidedOpen.value,
    );
  }
  if (finalVoteReady.value) return t("session.now.document.readyForFinal");
  if (!current.voted) return t("session.now.document.notVoted");
  return t("session.now.document.waiting");
});

const itemDocuments = computed(() =>
  (liveRow.value?.documents ?? []).filter(
    (document) => document.status === "published",
  ),
);

// Screen readers ---------------------------------------------------------------

const stageText = useSessionStageLabel();

/** What the polite live region says: what is debated and where it stands. */
const announcement = computed(() => {
  switch (mode.value) {
    case "idle":
      return t("session.now.idle");
    case "elsewhere":
      return t("session.now.announce", {
        what:
          liveDocumentSummary.value?.title ?? t("session.now.otherDocument"),
      });
    case "amendment": {
      const amendment = session.debatedAmendment.value;
      if (!amendment) {
        return t("session.now.announce", {
          what: session.label(live.value?.amendmentId ?? ""),
        });
      }
      return t("session.now.announceAmendment", {
        code: session.label(amendment.id),
        who: amendment.authors.map((author) => author.acronym).join(", "),
        status: stageText(session.stageOf(amendment), amendment),
      });
    }
    case "document": {
      const title = document.value?.title ?? liveDocumentSummary.value?.title;
      return title ? t("session.now.announce", { what: title }) : "";
    }
    case "item":
      return liveRow.value
        ? t("session.now.announce", {
            what: `${liveRow.value.number}. ${liveRow.value.item.title}`,
          })
        : "";
    default:
      return "";
  }
});
</script>

<template>
  <section
    class="border-primary/40 bg-default space-y-4 rounded-xl border-2 p-4 sm:p-5"
    aria-labelledby="session-now-title"
  >
    <p class="sr-only" aria-live="polite" aria-atomic="true">
      {{ announcement }}
    </p>

    <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <UIcon
        name="i-lucide-radio"
        class="text-primary size-4 shrink-0"
        aria-hidden="true"
      />
      <h2
        id="session-now-title"
        class="text-primary text-xs font-semibold tracking-wide uppercase"
      >
        {{ t("session.now.title") }}
      </h2>
      <p v-if="context" class="text-muted min-w-0 truncate text-sm">
        {{ context }}
      </p>
    </div>

    <div v-if="mode === 'loading'" class="space-y-3" aria-busy="true">
      <USkeleton class="h-10 w-2/3" />
      <USkeleton class="h-6 w-full" />
    </div>

    <!-- Nothing under debate yet. -->
    <template v-else-if="mode === 'idle'">
      <p class="text-highlighted text-2xl font-bold">
        {{ t("session.now.idle") }}
      </p>
      <p class="text-default">
        {{ nextAgenda ? t("session.now.idleHint") : t("session.agenda.empty") }}
      </p>
      <UButton
        v-if="nextAgenda"
        size="lg"
        icon="i-lucide-play"
        :label="t('session.now.start', { title: nextAgendaLabel })"
        :loading="liveBusy"
        @click="session.debateAgendaTarget(nextAgenda)"
      />
    </template>

    <!-- This device is looking at another document. -->
    <template v-else-if="mode === 'elsewhere'">
      <p class="text-highlighted text-2xl font-bold">
        {{ liveDocumentSummary?.title ?? t("session.now.otherDocument") }}
      </p>
      <UAlert
        color="info"
        variant="subtle"
        icon="i-lucide-eye"
        :title="t('session.now.elsewhere')"
        :description="t('session.now.elsewhereHint')"
      />
      <UButton
        size="lg"
        icon="i-lucide-undo-2"
        :label="t('session.now.followLive')"
        @click="session.followLive()"
      />
    </template>

    <!-- An amendment. -->
    <template v-else-if="mode === 'amendment'">
      <SessionNowAmendment
        v-if="session.debatedAmendment.value"
        :amendment="session.debatedAmendment.value"
      />
      <div v-else-if="!amendmentsLoaded" class="space-y-3" aria-busy="true">
        <USkeleton class="h-10 w-1/3" />
        <USkeleton class="h-24 w-full" />
      </div>
      <template v-else>
        <p class="text-highlighted text-2xl font-bold">
          {{
            t("session.card.label", {
              code: session.label(live?.amendmentId ?? ""),
            })
          }}
        </p>
        <p class="text-default">{{ t("session.now.amendmentMissing") }}</p>
        <UButton
          color="neutral"
          variant="outline"
          icon="i-lucide-radio-tower"
          :label="t('session.actions.undebate')"
          :loading="liveBusy"
          @click="session.clearDebatedAmendment()"
        />
      </template>
    </template>

    <!-- A document, between amendments. -->
    <template v-else-if="mode === 'document'">
      <div class="space-y-1">
        <p class="text-highlighted text-2xl font-bold sm:text-3xl">
          {{ document?.title ?? liveDocumentSummary?.title ?? "" }}
        </p>
        <p
          v-if="document?.reference ?? liveDocumentSummary?.reference"
          class="text-muted text-sm"
        >
          {{ document?.reference ?? liveDocumentSummary?.reference }}
        </p>
      </div>

      <div
        v-if="!document || (!amendmentsLoaded && document.amendable)"
        class="space-y-2"
        aria-busy="true"
      >
        <USkeleton class="h-6 w-2/3" />
      </div>
      <template v-else>
        <p class="text-default text-base font-medium">{{ documentStatus }}</p>
        <ul
          v-if="!next && !finalVote && finalVoteReasons.length > 0"
          class="text-muted list-disc space-y-1 ps-5 text-sm"
        >
          <li v-for="reason in finalVoteReasons" :key="reason">
            {{ reason }}
          </li>
        </ul>

        <UAlert
          v-if="lateCount > 0"
          color="warning"
          variant="subtle"
          icon="i-lucide-clock-alert"
          :title="t('session.now.late', { count: lateCount }, lateCount)"
          :description="t('session.queue.lateHint')"
          :actions="[
            {
              label: t(
                'session.queue.lateDecide',
                { count: lateCount },
                lateCount,
              ),
              color: 'warning',
              variant: 'soft',
              icon: 'i-lucide-gavel',
              onClick: () =>
                session.openAdmission(
                  session.queue.value.pending.map((amendment) => amendment.id),
                  'admitted',
                ),
            },
          ]"
        />

        <div class="flex flex-wrap items-center gap-2">
          <UButton
            v-if="next"
            size="lg"
            icon="i-lucide-play"
            :label="
              t('session.now.startWith', { code: session.label(next.id) })
            "
            :loading="liveBusy"
            @click="session.debateNext()"
          />
          <UButton
            v-else-if="finalVoteReady"
            size="lg"
            icon="i-lucide-gavel"
            :label="t('session.finalVote.open')"
            @click="session.finalVoteDialog.open = true"
          />
          <UButton
            v-if="nextAgenda"
            :size="!next && !finalVoteReady ? 'lg' : 'md'"
            :color="!next && !finalVoteReady ? 'primary' : 'neutral'"
            :variant="!next && !finalVoteReady ? 'solid' : 'ghost'"
            trailing-icon="i-lucide-arrow-right"
            :label="t('session.now.nextItem', { title: nextAgendaLabel })"
            :loading="liveBusy && !next"
            @click="session.debateAgendaTarget(nextAgenda)"
          />
        </div>
      </template>
    </template>

    <!-- An agenda item without a document in debate. -->
    <template v-else-if="mode === 'item' && liveRow">
      <p class="text-highlighted text-2xl font-bold sm:text-3xl">
        {{ `${liveRow.number}. ${liveRow.item.title}` }}
      </p>
      <p class="text-default">
        {{
          itemDocuments.length > 0
            ? t(
                "session.now.item.documents",
                { count: itemDocuments.length },
                itemDocuments.length,
              )
            : t("session.now.item.noDocuments")
        }}
      </p>
      <ul v-if="itemDocuments.length > 0" class="space-y-2">
        <li
          v-for="(item, index) in itemDocuments"
          :key="item.id"
          class="border-default flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2"
        >
          <span class="min-w-0 flex-1">
            <span class="text-highlighted block truncate font-medium">
              {{ item.title }}
            </span>
            <span v-if="item.reference" class="text-muted text-xs">
              {{ item.reference }}
            </span>
          </span>
          <UButton
            :color="index === 0 ? 'primary' : 'neutral'"
            :variant="index === 0 ? 'solid' : 'outline'"
            icon="i-lucide-radio"
            :label="t('session.agenda.debateDocument')"
            :aria-label="
              t('session.agenda.debateDocumentNamed', { title: item.title })
            "
            :disabled="liveBusy"
            @click="session.debateDocument(item)"
          />
        </li>
      </ul>
      <UButton
        v-if="nextAgenda"
        :size="itemDocuments.length === 0 ? 'lg' : 'md'"
        :color="itemDocuments.length === 0 ? 'primary' : 'neutral'"
        :variant="itemDocuments.length === 0 ? 'solid' : 'ghost'"
        trailing-icon="i-lucide-arrow-right"
        :label="t('session.now.nextItem', { title: nextAgendaLabel })"
        :loading="liveBusy"
        @click="session.debateAgendaTarget(nextAgenda)"
      />
    </template>

    <p v-else class="text-muted">{{ t("session.now.idle") }}</p>
  </section>
</template>
