<script setup lang="ts">
import {
  liveAmendmentCode,
  liveReplacedBy,
  type LiveAmendmentRow,
  type LiveAmendmentState,
} from "~/components/live-view/-model";
import { thirdCount, voteTextKey } from "~~/shared/utils/votes";
import { PROJECTION_STATE_COLORS } from "~/utils/statusColors";
import { OUTCOME_TEXT } from "~/utils/statusTone";

/**
 * The amendments of the document in debate as the projection shows them
 * beside the amendment on screen, in the style of its agenda
 * (SessionProjectionAgenda, compact): one narrow column, the amendment on
 * screen highlighted with the brand colour and marked as the current step.
 * Each row says its code and who presents it; only a decided one says how
 * it ended, so the list stays calm while the debate goes on: one voted
 * gives its result and counts («Aprobada 20 / 5 / 3»), one transacted the
 * transactional that replaced it (an icon and its code), and the rest
 * their state (user's decision of 2026-11-20).
 */
const props = defineProps<{
  rows: LiveAmendmentRow[];
  /**
   * The amendments of a bloc on screen: marked with a lighter tint than
   * the one on screen (user's decision of 2026-11-20).
   */
  marked?: ReadonlySet<string>;
}>();

const { t } = useI18n();
const alternativesText = useAlternativesVoteText();

/** Undecided rows say nothing: the highlight already marks the one debated. */
const QUIET: ReadonlySet<LiveAmendmentState> = new Set(["debating", "pending"]);

/**
 * A decided row's state in its colour (PROJECTION_STATE_COLORS: lapsed grey,
 * as closed); the colours without a result text (transacted, turned down,
 * withdrawn, the undecided ones) dimmed.
 */
function stateClass(row: LiveAmendmentRow): string {
  if (row.current) return "text-inverted";
  const color = PROJECTION_STATE_COLORS[row.state];
  return color in OUTCOME_TEXT
    ? OUTCOME_TEXT[color as keyof typeof OUTCOME_TEXT]
    : "text-dimmed";
}

const STATE_ICONS: Partial<Record<LiveAmendmentState, string>> = {
  approved: "i-lucide-check",
  incorporated: "i-lucide-check",
  rejected: "i-lucide-x",
  transacted: "i-lucide-git-merge",
};

interface Outcome {
  icon: string | null;
  /** What the row shows: the state, or the transactional's code. */
  text: string;
  /** The vote's counts, «20 / 5 / 3», when it was voted. */
  counts: string | null;
  /** The whole of it for screen readers. */
  spoken: string;
}

/** How a decided amendment ended; null while it is undecided. */
function outcomeOf(row: LiveAmendmentRow): Outcome | null {
  if (QUIET.has(row.state)) return null;
  const label = t(`liveView.state.${row.state}.label`);
  const icon = STATE_ICONS[row.state] ?? null;
  if (row.state === "transacted") {
    const code = liveAmendmentCode(liveReplacedBy(row, props.rows)?.amendment);
    return code
      ? {
          icon,
          text: code,
          counts: null,
          spoken: t("liveView.state.transacted.by", { code }),
        }
      : { icon, text: label, counts: null, spoken: label };
  }
  const vote = row.amendment.outcomeVote;
  // A vote between alternatives: its option and that option's votes.
  const optionIndex =
    vote?.options?.findIndex((option) =>
      option.amendmentIds.includes(row.amendment.id),
    ) ?? -1;
  if (vote && optionIndex >= 0) {
    const option = alternativesText.optionName(optionIndex);
    const count = vote.options![optionIndex]!.count;
    return {
      icon,
      text: label,
      counts: `${option} · ${count}`,
      spoken: `${label}. ${option}: ${count}`,
    };
  }
  if (vote && (row.state === "approved" || row.state === "rejected")) {
    return {
      icon,
      text: label,
      counts: `${vote.inFavor} / ${vote.against} / ${thirdCount(vote)}`,
      spoken: `${label}. ${t(
        voteTextKey("projection.resultCounts", vote.method),
        {
          inFavor: vote.inFavor,
          against: vote.against,
          third: thirdCount(vote),
        },
      )}`,
    };
  }
  return { icon, text: label, counts: null, spoken: label };
}

const entries = computed(() =>
  props.rows.map((row) => ({
    row,
    code:
      liveAmendmentCode(row.amendment) ||
      t(`session.enums.amendmentKind.${row.amendment.kind}`),
    authors: row.amendment.authors.map((author) => author.acronym).join(", "),
    authorNames: row.amendment.authors.map((author) => author.name).join(", "),
    outcome: outcomeOf(row),
  })),
);
</script>

<template>
  <ol class="space-y-2">
    <li
      v-for="entry in entries"
      :key="entry.row.amendment.id"
      class="relative flex flex-wrap items-baseline gap-x-3 rounded-xl px-4 py-2 text-[clamp(1rem,1.3vw,1.5rem)] transition-colors duration-500 motion-reduce:transition-none"
      :class="
        entry.row.current
          ? 'bg-primary text-inverted font-bold'
          : props.marked?.has(entry.row.amendment.id)
            ? 'bg-primary/15 text-highlighted font-semibold'
            : 'text-muted'
      "
      :aria-current="entry.row.current ? 'step' : undefined"
      :data-marked="props.marked?.has(entry.row.amendment.id) || undefined"
    >
      <span class="shrink-0 font-semibold tabular-nums">{{ entry.code }}</span>
      <!-- Acronyms on screen, full names for screen readers. A joint
           amendment's list wraps, never cut: the room reads who signs it
           (E-126); the state stays on the first line. -->
      <span v-if="entry.authors" class="min-w-0 flex-1 break-words">
        <span aria-hidden="true">{{ entry.authors }}</span>
        <span class="sr-only">{{ entry.authorNames }}</span>
      </span>
      <span v-else class="flex-1" />
      <template v-if="entry.outcome">
        <span
          class="flex shrink-0 items-center gap-1 text-[0.8em] font-semibold"
          :class="stateClass(entry.row)"
        >
          <UIcon
            v-if="entry.outcome.icon"
            :name="entry.outcome.icon"
            class="size-[1.1em] shrink-0 self-center"
            aria-hidden="true"
          />
          <span aria-hidden="true" class="tabular-nums">
            {{ entry.outcome.text }}
          </span>
          <span class="sr-only">{{ entry.outcome.spoken }}</span>
        </span>
        <!-- The counts under it, at the right, as the state above. -->
        <span
          v-if="entry.outcome.counts"
          class="basis-full text-end text-[0.8em] font-semibold tabular-nums"
          :class="stateClass(entry.row)"
          aria-hidden="true"
        >
          {{ entry.outcome.counts }}
        </span>
      </template>
    </li>
  </ol>
</template>
