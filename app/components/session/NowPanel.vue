<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";
import type { DocumentSummaryDto } from "~~/shared/types/api";
import {
  isSessionOpen,
  isSessionPendingAdmission,
  sessionItemDocuments,
  sessionItemVotePlan,
  sessionNextItemDocument,
  sessionSubItemsLeft,
} from "~/composables/session/sessionModel";
import { admissionDecisionOf } from "~/composables/session/admissionProposal";
import { liveBlocOutcome } from "~/components/live-view/-model";
import { useFinalVoteReasonText } from "~/composables/session/useFinalVoteReasonText";
import { useItemVoteText } from "~/composables/session/useItemVoteText";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";
import { useSessionStageLabel } from "~/composables/session/useSessionStageLabel";

/**
 * "Ahora en debate": what the room is debating now, in large type, with
 * where it stands and the next step as one primary action. It follows the
 * live state, so every Mesa device shows the same thing:
 *
 * - nothing yet: start with the first agenda item;
 * - an agenda item: its documents, or the next item; an item none of whose
 *   documents is voted may take a vote of its own (a ratification, an
 *   election), the main action when it is marked «Se vota el punto» and
 *   has no vote in force, and then one line says how it went; "Más" votes
 *   it again, voids the vote or changes its unanimity. One with sub-items
 *   goes through them first (the next item is the main action while any
 *   is untreated) and, after the last, «Volver a … para votarlo» brings
 *   the debate back to it (sessionNextAgendaTarget);
 * - a document: the same card of its item (user's decision of 2026-11-18),
 *   its row marked as the one in debate and pressed again to take it out;
 *   under it, where it stands and its next step: the next amendment the
 *   Mesa can decide, then the final vote. None of the item's documents is
 *   pushed as the next step: the Mesa picks; a bloc on screen (user's
 *   decision of 2026-11-19) shows there with its codes, approves by assent
 *   what is left of it and is taken off;
 * - an amendment: its change and the actions that fit (NowAmendment).
 *
 * When this device is looking at another document than the one in debate,
 * it says so and offers to go back. Until the session is open nothing is
 * debated: the buttons that would put something on screen are disabled
 * (the console says why above).
 *
 * One region that is always there tells screen readers what is debated now
 * and where it stands, so a change made from another Mesa device is
 * announced too (a region inserted with its content usually is not).
 */
const session = useSessionConsoleContext();
const { t } = useI18n();

// What this console debates: the projection with control, else its own.
const live = computed(() => session.debate.value);

/**
 * What is on screen, for a console that does not control the projection:
 * the amendment's code, the document or the agenda item.
 */
const screenLine = computed(() => {
  if (session.inControl.value) return null;
  const screen = session.liveState.value;
  if (!screen) return null;
  const documentTitle = screen.documentId
    ? session.agenda.value?.documents.find(
        (document) => document.id === screen.documentId,
      )?.title
    : null;
  const row = screen.agendaItemId
    ? session.agendaRows.value.find(
        (other) => other.item.id === screen.agendaItemId,
      )
    : null;
  const bloc = screen.amendmentBloc ?? [];
  const what = [
    screen.amendmentId && session.byId.value.has(screen.amendmentId)
      ? session.label(screen.amendmentId)
      : null,
    bloc.length > 0
      ? t(
          screen.amendmentBlocPurpose
            ? "session.admissionProposal.onScreenWhat"
            : "session.bloc.onScreenWhat",
          { count: bloc.length },
          bloc.length,
        )
      : null,
    documentTitle ??
      (row
        ? numberedAgendaTitle(
            row.number,
            row.item.title,
            t("agenda.unlisted.inText"),
          )
        : null),
  ].filter((part): part is string => Boolean(part));
  return what.length > 0
    ? t("session.control.onScreen", { what: what.join(" · ") })
    : t("session.control.onScreenNothing");
});
const liveBusy = computed(() => Boolean(session.busy.value.live));
/** Nothing goes on screen or is recorded before the session opens. */
const closed = computed(() => !session.inSession.value);

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

/** "3. Resoluciones"; an item without a number says it is not published. */
const rowLabel = (row: { number: string | null; item: { title: string } }) =>
  numberedAgendaTitle(row.number, row.item.title, t("agenda.unlisted.inText"));

/** The context line above the headline: agenda item and document. */
const context = computed(() =>
  [
    liveRow.value ? rowLabel(liveRow.value) : null,
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
  nextAgenda.value ? rowLabel(nextAgenda.value.row) : "",
);
/** «Siguiente punto: …», or back to an item voted as a whole to vote it. */
const nextAgendaText = computed(() =>
  nextAgenda.value?.returning
    ? t("session.now.backToVote", { title: nextAgendaLabel.value })
    : t("session.now.nextItem", { title: nextAgendaLabel.value }),
);

/** The published documents of the item in debate, in the agenda's order. */
const itemDocuments = computed(() => sessionItemDocuments(liveRow.value));
/** The item's document after the one in debate, before the next item. */
const nextDocument = computed(() =>
  sessionNextItemDocument(liveRow.value, live.value?.documentId ?? null),
);
/** The document in debate, if any. */
const selectedId = computed(() => live.value?.documentId ?? null);
/**
 * The documents the card lists: the item's, or the one in debate alone
 * when the agenda does not have its item.
 */
const cardDocuments = computed<DocumentSummaryDto[]>(() => {
  if (itemDocuments.value.length > 0) return itemDocuments.value;
  return liveDocumentSummary.value ? [liveDocumentSummary.value] : [];
});

/** Puts a document in debate, or takes the one in debate out of it. */
function toggleDocument(item: DocumentSummaryDto): void {
  if (item.id === selectedId.value) void session.clearDebatedDocument();
  else void session.debateDocument(item);
}

// Document under debate ------------------------------------------------------------

const document = computed(() => session.document.value ?? null);
const amendmentsLoaded = computed(() => Boolean(session.amendmentsDto.value));
const next = computed(() => session.nextAmendment.value);
const lateCount = computed(() => session.queue.value.pending.length);
/** Amendments the Mesa can still decide (validated and admitted). */
const undecidedOpen = computed(
  () => session.amendments.value.filter(isSessionOpen).length,
);
const reasonText = useFinalVoteReasonText();
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
    if (finalVote.value.result !== "approved") {
      return t("session.preview.finalRejected");
    }
    return current.pendingConciliation > 0
      ? t("session.preview.finalApprovedPending")
      : t("session.preview.finalApproved");
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

// A bloc on screen ------------------------------------------------------------------

/** The bloc on screen, in text order, each with whether it is decided. */
const bloc = computed(() => {
  const ids = new Set(session.blocOnScreen.value);
  return session.amendments.value
    .filter((amendment) => ids.has(amendment.id))
    .map((amendment) => ({
      id: amendment.id,
      code: session.label(amendment.id),
      approved: amendment.status === "approved",
      open: isSessionOpen(amendment),
    }));
});
const blocOpenIds = computed(() =>
  bloc.value.filter((entry) => entry.open).map((entry) => entry.id),
);
const blocApproved = computed(
  () => bloc.value.filter((entry) => entry.approved).length,
);

/**
 * A proposal to admit late amendments or not on screen (user's decision of
 * 2026-11-21): its codes in text order, each with what was decided, and
 * those still pending, which «Decidir admisión» opens the dialog on.
 */
const proposal = computed(() => {
  const onScreen = session.proposalOnScreen.value;
  if (!onScreen) return null;
  const ids = new Set(onScreen.ids);
  const entries = session.amendments.value
    .filter((amendment) => ids.has(amendment.id))
    .map((amendment) => ({
      id: amendment.id,
      code: session.label(amendment.id),
      outcome: liveBlocOutcome(amendment, onScreen.purpose),
      pending: isSessionPendingAdmission(amendment),
    }));
  return {
    purpose: onScreen.purpose,
    entries,
    pendingIds: entries
      .filter((entry) => entry.pending)
      .map((entry) => entry.id),
  };
});

// Agenda item under debate ---------------------------------------------------------

/**
 * The item's own vote: whether it takes one (none of its documents the Mesa
 * receives is voted, whatever their status, and it is not a container), the
 * vote in force and whether recording it is the next step.
 */
const itemPlan = computed(() =>
  liveRow.value
    ? sessionItemVotePlan(
        liveRow.value,
        session.itemVotes.value,
        session.assembly.value?.status,
      )
    : null,
);
const itemVote = computed(() => itemPlan.value?.vote ?? null);
/** Recording is offered as a button until a vote is in force. */
const offerItemVote = computed(
  () => Boolean(itemPlan.value?.canRecord) && !itemVote.value,
);
/**
 * An item voted as a whole with sub-items not gone through yet (user's
 * decision of 2026-11-21): the Mesa goes through them first and comes back
 * to vote.
 */
const subItemsFirst = computed(
  () =>
    Boolean(itemPlan.value?.pending) &&
    liveRow.value !== null &&
    sessionSubItemsLeft(
      session.agendaRows.value,
      liveRow.value.item.id,
      session.itemGoneThrough,
    ),
);
/**
 * «Se vota el punto» and no vote yet: the vote is the main action, once
 * its sub-items, if any, are gone through.
 */
const itemVotePending = computed(
  () => Boolean(itemPlan.value?.pending) && !subItemsFirst.value,
);

/**
 * "Siguiente punto" is the main step once nothing else is left: no
 * document to debate (and no vote of the item pending) or, with one in
 * debate, no amendment, no final vote and no other document after it.
 */
const nextItemPrimary = computed(() => {
  if (itemVotePending.value) return false;
  if (!selectedId.value) {
    return cardDocuments.value.length === 0 || subItemsFirst.value;
  }
  return !next.value && !finalVoteReady.value && !nextDocument.value;
});

const itemVoteText = useItemVoteText();
const itemVoteBusy = computed(
  () =>
    Boolean(session.busy.value["item-vote"]) ||
    (itemVote.value
      ? Boolean(session.busy.value[`vote-${itemVote.value.id}`])
      : false),
);

function openItemVote(): void {
  if (liveRow.value) session.openItemVote(liveRow.value.item.id);
}

/**
 * "Más" of an agenda item: with a vote in force, vote it again, change its
 * unanimity (an assent) or void it; undo the treated mark presenting it set,
 * or set it again; and end the debate altogether.
 */
const itemMoreItems = computed<DropdownMenuItem[][]>(() => {
  const groups: DropdownMenuItem[][] = [];
  const plan = itemPlan.value;
  const vote = itemVote.value;
  if (plan && vote) {
    const voteItems: DropdownMenuItem[] = [];
    if (plan.canRecord) {
      voteItems.push({
        label: t("session.itemVote.openAgain"),
        icon: "i-lucide-gavel",
        onSelect: openItemVote,
      });
    }
    if (plan.canChange && vote.method === "assent") {
      voteItems.push({
        label: vote.unanimous
          ? t("session.itemVote.unmarkUnanimous")
          : t("session.itemVote.markUnanimous"),
        icon: vote.unanimous ? "i-lucide-minus" : "i-lucide-check-check",
        disabled: itemVoteBusy.value,
        onSelect: () => void session.setVoteUnanimity(vote, !vote.unanimous),
      });
    }
    if (plan.canChange) {
      voteItems.push({
        label: t("session.itemVote.void"),
        icon: "i-lucide-rotate-ccw",
        disabled: itemVoteBusy.value,
        onSelect: () =>
          void session.voidItemVote(vote, itemVoteText.line(vote)),
      });
    }
    if (voteItems.length > 0) groups.push(voteItems);
  }
  // Presenting it marked it treated: a wrong click is undone here, and a
  // mark taken away is set again (user's decision of 2026-11-19).
  const itemId = live.value?.agendaItemId;
  const markAction = itemId ? session.itemMarkAction(itemId) : null;
  if (itemId && markAction) {
    groups.push([
      {
        label:
          markAction === "unmark"
            ? t("session.progress.unmark")
            : t("session.progress.mark"),
        icon:
          markAction === "unmark" ? "i-lucide-rotate-ccw" : "i-lucide-check",
        disabled: Boolean(session.busy.value[`treated-${itemId}`]),
        onSelect: () =>
          void session.setItemTreated(itemId, markAction === "mark"),
      },
    ]);
  }
  groups.push([
    {
      label: t("session.now.undebateItem"),
      icon: "i-lucide-radio-tower",
      onSelect: () => void session.clearDebate(),
    },
  ]);
  return groups;
});

/** The sentence under the item's title, until a document is in debate. */
const itemSentence = computed(() => {
  if (selectedId.value) return null;
  const count = itemDocuments.value.length;
  if (count > 0) return t("session.now.item.documents", { count }, count);
  return itemVotePending.value
    ? t("session.now.item.toVote")
    : t("session.now.item.noDocuments");
});

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
      // Silent while the amendments load: its code is not known yet.
      if (!amendment) {
        return amendmentsLoaded.value ? t("session.now.amendmentMissing") : "";
      }
      return t("session.now.announceAmendment", {
        code: session.label(amendment.id),
        who: amendment.authors.map((author) => author.acronym).join(", "),
        status: stageText(session.stageOf(amendment), amendment),
      });
    }
    case "document": {
      const title = document.value?.title ?? liveDocumentSummary.value?.title;
      if (!title) return "";
      const what = t("session.now.announce", { what: title });
      return bloc.value.length > 0
        ? `${what}. ${t("session.bloc.announce", {
            codes: bloc.value.map((entry) => entry.code).join(", "),
          })}`
        : what;
    }
    case "item": {
      if (!liveRow.value) return "";
      const what = t("session.now.announce", { what: rowLabel(liveRow.value) });
      // A vote recorded here or on another Mesa device is announced too.
      return itemVote.value
        ? `${what}. ${itemVoteText.spoken(itemVote.value)}`
        : what;
    }
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

    <!-- Without control: this console works on its own; the screen is
         another console's. -->
    <div
      v-if="screenLine"
      class="border-default bg-elevated/50 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm"
    >
      <p class="text-muted flex min-w-0 items-center gap-2">
        <UIcon
          name="i-lucide-monitor"
          class="size-4 shrink-0"
          aria-hidden="true"
        />
        <span class="min-w-0">{{ screenLine }}</span>
      </p>
      <UButton
        v-if="session.awayFromScreen.value"
        size="xs"
        color="neutral"
        variant="outline"
        icon="i-lucide-undo-2"
        :label="t('session.control.followScreen')"
        @click="session.followScreen()"
      />
    </div>

    <div v-if="mode === 'loading'" class="space-y-3" role="status">
      <span class="sr-only">{{ t("common.loading") }}</span>
      <USkeleton aria-hidden="true" class="h-10 w-2/3" />
      <USkeleton aria-hidden="true" class="h-6 w-full" />
    </div>

    <!-- Nothing under debate yet. -->
    <template v-else-if="mode === 'idle'">
      <h3 class="text-highlighted text-2xl font-bold">
        {{ t("session.now.idle") }}
      </h3>
      <p class="text-default">
        {{
          !nextAgenda
            ? t("session.agenda.empty")
            : closed
              ? t("session.now.idleClosed")
              : t("session.now.idleHint")
        }}
      </p>
      <UButton
        v-if="nextAgenda"
        size="lg"
        icon="i-lucide-play"
        :label="t('session.now.start', { title: nextAgendaLabel })"
        :loading="liveBusy"
        :disabled="closed"
        @click="session.debateAgendaTarget(nextAgenda)"
      />
    </template>

    <!-- This device is looking at another document. -->
    <template v-else-if="mode === 'elsewhere'">
      <h3 class="text-highlighted text-2xl font-bold">
        {{ liveDocumentSummary?.title ?? t("session.now.otherDocument") }}
      </h3>
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
      <div v-else-if="!amendmentsLoaded" class="space-y-3" role="status">
        <span class="sr-only">{{ t("common.loading") }}</span>
        <USkeleton aria-hidden="true" class="h-10 w-1/3" />
        <USkeleton aria-hidden="true" class="h-24 w-full" />
      </div>
      <template v-else>
        <h3 class="text-highlighted text-2xl font-bold">
          {{
            t("session.card.label", {
              code: session.label(live?.amendmentId ?? ""),
            })
          }}
        </h3>
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

    <!-- An agenda item, with or without one of its documents in debate. -->
    <template
      v-else-if="
        (mode === 'item' || mode === 'document') &&
        (liveRow || cardDocuments.length > 0)
      "
    >
      <h3 class="text-highlighted text-2xl font-bold sm:text-3xl">
        {{
          liveRow
            ? rowLabel(liveRow)
            : (document?.title ?? liveDocumentSummary?.title ?? "")
        }}
      </h3>
      <p
        v-if="itemVote"
        class="text-default flex items-center gap-2 text-base font-medium"
      >
        <UIcon
          :name="
            itemVote.result === 'approved'
              ? 'i-lucide-circle-check'
              : 'i-lucide-circle-x'
          "
          class="size-5 shrink-0"
          :class="
            itemVote.result === 'approved' ? 'text-success' : 'text-error'
          "
          aria-hidden="true"
        />
        <span class="tabular-nums">{{ itemVoteText.line(itemVote) }}</span>
      </p>
      <p v-if="itemSentence" class="text-default">{{ itemSentence }}</p>
      <ul v-if="cardDocuments.length > 0" class="space-y-2">
        <li
          v-for="item in cardDocuments"
          :key="item.id"
          class="rounded-lg border px-3 py-2"
          :class="
            item.id === selectedId
              ? 'border-primary/50 bg-primary/5'
              : 'border-default'
          "
        >
          <div class="flex flex-wrap items-center gap-2">
            <span class="min-w-0 flex-1">
              <span
                class="block truncate font-medium"
                :class="
                  item.id !== selectedId &&
                  session.documentProgress(item.id) === 'treated'
                    ? 'text-muted'
                    : 'text-highlighted'
                "
              >
                {{ item.title }}
              </span>
              <span class="flex flex-wrap items-center gap-x-2">
                <span v-if="item.reference" class="text-muted text-xs">
                  {{ item.reference }}
                </span>
                <SessionProgressMark
                  v-if="item.id !== selectedId"
                  :progress="session.documentProgress(item.id)"
                />
              </span>
            </span>
            <!-- A toggle: pressed again, it takes the document out. -->
            <UTooltip
              :text="t('session.now.undebateDocument')"
              :disabled="item.id !== selectedId"
            >
              <UButton
                :color="item.id === selectedId ? 'primary' : 'neutral'"
                :variant="item.id === selectedId ? 'soft' : 'outline'"
                icon="i-lucide-radio"
                :label="
                  item.id === selectedId
                    ? t('session.now.inDebate')
                    : t('session.agenda.debateDocument')
                "
                :aria-label="
                  item.id === selectedId
                    ? t('session.now.documentInDebate', { title: item.title })
                    : t('session.agenda.debateDocumentNamed', {
                        title: item.title,
                      })
                "
                :aria-pressed="item.id === selectedId"
                :disabled="closed || liveBusy"
                @click="toggleDocument(item)"
              />
            </UTooltip>
          </div>

          <!-- Where the document in debate stands, and its next step. -->
          <div
            v-if="item.id === selectedId"
            class="border-primary/20 mt-2 space-y-3 border-t pt-3"
          >
            <div
              v-if="!document || (!amendmentsLoaded && document.amendable)"
              class="space-y-2"
              role="status"
            >
              <span class="sr-only">{{ t("common.loading") }}</span>
              <USkeleton aria-hidden="true" class="h-5 w-2/3" />
            </div>
            <template v-else>
              <p class="text-default text-sm font-medium">
                {{ documentStatus }}
              </p>
              <ul
                v-if="!next && !finalVote && finalVoteReasons.length > 0"
                class="text-muted list-disc space-y-1 ps-5 text-sm"
              >
                <li v-for="reason in finalVoteReasons" :key="reason">
                  {{ reason }}
                </li>
              </ul>
              <!-- The way to what holds the vote back (user's decision of
                   2026-11-20): each passage still to word opens its
                   wording, as «Texto consolidado» does. -->
              <div
                v-if="
                  !next &&
                  !finalVote &&
                  document.can.moderate &&
                  session.pendingPassages.value.length > 0
                "
                class="flex flex-wrap gap-2"
              >
                <UButton
                  v-for="passage in session.pendingPassages.value"
                  :key="passage.key"
                  size="sm"
                  color="neutral"
                  variant="outline"
                  icon="i-lucide-pen-line"
                  :label="
                    t('session.wording.setFor', {
                      codes: passage.amendmentIds.map(session.label).join(', '),
                    })
                  "
                  data-testid="session-now-word-passage"
                  @click="session.openWording(passage)"
                />
              </div>

              <!-- The bloc on screen: its codes, approved ones marked. -->
              <section
                v-if="bloc.length > 0"
                class="border-primary/30 bg-primary/5 space-y-2 rounded-lg border p-3"
                aria-labelledby="session-now-bloc-title"
              >
                <p
                  id="session-now-bloc-title"
                  class="text-highlighted flex items-center gap-2 text-sm font-semibold"
                >
                  <UIcon
                    name="i-lucide-monitor"
                    class="text-primary size-4 shrink-0"
                    aria-hidden="true"
                  />
                  {{
                    session.roomAlternatives.value
                      ? t("session.alternatives.onScreen")
                      : t("session.bloc.onScreen")
                  }}
                  <span class="text-muted font-normal tabular-nums">
                    {{
                      t("session.bloc.progress", {
                        approved: blocApproved,
                        total: bloc.length,
                      })
                    }}
                  </span>
                </p>
                <ul class="flex flex-wrap gap-1.5">
                  <li v-for="entry in bloc" :key="entry.id">
                    <UBadge
                      :color="entry.approved ? 'success' : 'neutral'"
                      :variant="entry.approved ? 'subtle' : 'outline'"
                      :icon="entry.approved ? 'i-lucide-check' : undefined"
                      :label="entry.code"
                    />
                  </li>
                </ul>
                <div class="flex flex-wrap items-center gap-2">
                  <!-- Alternatives on screen are voted between, never
                       approved by assent. -->
                  <UButton
                    v-if="session.roomAlternatives.value"
                    size="sm"
                    color="primary"
                    icon="i-lucide-scale"
                    :label="t('session.alternatives.open')"
                    :disabled="closed"
                    @click="session.openAlternatives([])"
                  />
                  <template v-else-if="blocOpenIds.length > 0">
                    <UButton
                      size="sm"
                      color="success"
                      icon="i-lucide-check-check"
                      :label="t('session.bloc.approve')"
                      :disabled="closed"
                      @click="session.openAssent(blocOpenIds)"
                    />
                    <UButton
                      v-if="blocOpenIds.length >= 2"
                      size="sm"
                      color="neutral"
                      variant="outline"
                      icon="i-lucide-gavel"
                      :label="t('session.blocVote.open')"
                      :disabled="closed"
                      @click="session.openBlocVote(blocOpenIds)"
                    />
                  </template>
                  <UButton
                    v-if="session.inControl.value"
                    size="sm"
                    color="neutral"
                    variant="ghost"
                    icon="i-lucide-monitor-off"
                    :label="t('session.bloc.unproject')"
                    :loading="liveBusy"
                    @click="session.unprojectBloc()"
                  />
                </div>
              </section>

              <!-- A proposal on admission on screen: its codes, each with
                   what was decided; it stays until the Mesa takes it off. -->
              <section
                v-if="proposal"
                class="border-warning/40 bg-warning/5 space-y-2 rounded-lg border p-3"
                aria-labelledby="session-now-proposal-title"
              >
                <p
                  id="session-now-proposal-title"
                  class="text-highlighted flex items-center gap-2 text-sm font-semibold"
                >
                  <UIcon
                    name="i-lucide-monitor"
                    class="text-warning size-4 shrink-0"
                    aria-hidden="true"
                  />
                  {{
                    t(`session.admissionProposal.onScreen.${proposal.purpose}`)
                  }}
                </p>
                <ul class="flex flex-wrap gap-1.5">
                  <li v-for="entry in proposal.entries" :key="entry.id">
                    <UBadge
                      :color="
                        entry.outcome === 'admitted' ? 'success' : 'neutral'
                      "
                      :variant="entry.outcome ? 'subtle' : 'outline'"
                      :icon="
                        entry.outcome === 'admitted'
                          ? 'i-lucide-check'
                          : entry.outcome === 'notAdmitted'
                            ? 'i-lucide-x'
                            : undefined
                      "
                      :label="entry.code"
                      :aria-label="
                        entry.outcome
                          ? `${entry.code}: ${t(`projection.proposal.${entry.outcome}`)}`
                          : entry.code
                      "
                    />
                  </li>
                </ul>
                <div class="flex flex-wrap items-center gap-2">
                  <UButton
                    v-if="proposal.pendingIds.length > 0"
                    size="sm"
                    color="warning"
                    variant="soft"
                    icon="i-lucide-gavel"
                    :label="t('session.admissionProposal.decide')"
                    :disabled="Boolean(session.busy.value.admission)"
                    @click="
                      session.openAdmission(
                        proposal.pendingIds,
                        admissionDecisionOf(proposal.purpose),
                      )
                    "
                  />
                  <UButton
                    v-if="session.inControl.value"
                    size="sm"
                    color="neutral"
                    variant="ghost"
                    icon="i-lucide-monitor-off"
                    :label="t('session.bloc.unproject')"
                    :loading="liveBusy"
                    @click="session.unprojectBloc()"
                  />
                </div>
              </section>

              <!-- One notice per fact: a proposal on screen already says it. -->
              <UAlert
                v-if="lateCount > 0 && !proposal"
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
                        session.queue.value.pending.map(
                          (amendment) => amendment.id,
                        ),
                        'admitted',
                      ),
                  },
                ]"
              />

              <div v-if="next || finalVoteReady">
                <UButton
                  v-if="next"
                  icon="i-lucide-play"
                  :label="
                    t('session.now.startWith', { code: session.label(next.id) })
                  "
                  :loading="liveBusy"
                  :disabled="closed"
                  @click="session.debateNext()"
                />
                <UButton
                  v-else
                  icon="i-lucide-gavel"
                  :label="t('session.finalVote.open')"
                  :disabled="closed"
                  @click="session.finalVoteDialog.open = true"
                />
              </div>
            </template>
          </div>
        </li>
      </ul>
      <div class="flex flex-wrap items-center gap-2">
        <UButton
          v-if="offerItemVote"
          :size="itemVotePending ? 'lg' : 'md'"
          :color="itemVotePending ? 'primary' : 'neutral'"
          :variant="itemVotePending ? 'solid' : 'outline'"
          icon="i-lucide-gavel"
          :label="t('session.itemVote.open')"
          :loading="itemVoteBusy"
          :disabled="closed"
          @click="openItemVote"
        />
        <!-- One row that never wraps: a long next item gives way (cut short)
             so that "Más" always fits beside it. -->
        <div class="flex max-w-full min-w-0 items-center gap-2">
          <UButton
            v-if="nextAgenda"
            :size="nextItemPrimary ? 'lg' : 'md'"
            :color="nextItemPrimary ? 'primary' : 'neutral'"
            :variant="nextItemPrimary ? 'solid' : 'ghost'"
            trailing-icon="i-lucide-arrow-right"
            class="min-w-0"
            :label="nextAgendaText"
            :disabled="closed || liveBusy"
            @click="session.debateAgendaTarget(nextAgenda)"
          />
          <UDropdownMenu :items="itemMoreItems" :content="{ align: 'end' }">
            <UButton
              color="neutral"
              variant="ghost"
              icon="i-lucide-ellipsis"
              class="shrink-0"
              :label="t('session.now.more')"
              :disabled="liveBusy"
            />
          </UDropdownMenu>
        </div>
      </div>
    </template>

    <p v-else class="text-muted">{{ t("session.now.idle") }}</p>
  </section>
</template>
