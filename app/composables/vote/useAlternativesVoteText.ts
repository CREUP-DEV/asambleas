import type { VoteDto } from "~~/shared/types/api";
import { alternativeLetter } from "~~/shared/utils/alternativesVote";

/**
 * How a vote between alternatives reads (user's decisions of 2026-11-20):
 * «Opción A: 12 · Opción B: 8 · 3 abstenciones» and what came of it («Ganó
 * la opción A», or what the Mesa did when none won). Every place that words
 * a vote's counts asks `isAlternatives` first: such a vote has no «a favor»
 * nor «en contra».
 */
export function useAlternativesVoteText() {
  const { t } = useI18n();

  function isAlternatives(vote: Pick<VoteDto, "options"> | null | undefined) {
    return Boolean(vote?.options && vote.options.length > 0);
  }

  /** «Opción A». */
  function optionName(index: number): string {
    return t("amendment.vote.alternatives.option", {
      letter: alternativeLetter(index),
    });
  }

  /** «Opción A: 12 · Opción B: 8 · 3 abstenciones». */
  function counts(
    vote: Pick<VoteDto, "options" | "method" | "abstentions" | "blank">,
  ): string {
    const options = (vote.options ?? []).map((option, index) =>
      t("amendment.vote.alternatives.optionCount", {
        option: optionName(index),
        count: option.count,
      }),
    );
    const rest =
      vote.method === "secret"
        ? t(
            "amendment.vote.alternatives.blank",
            { count: vote.blank },
            vote.blank,
          )
        : t(
            "amendment.vote.alternatives.abstentions",
            { count: vote.abstentions },
            vote.abstentions,
          );
    return [...options, rest].join(" · ");
  }

  /** «Ganó la opción A», or what the Mesa did when none won. */
  function outcome(
    vote: Pick<VoteDto, "winningOption" | "tieResolution">,
  ): string {
    if (vote.winningOption !== null) {
      return t("amendment.vote.alternatives.won", {
        letter: alternativeLetter(vote.winningOption),
      });
    }
    return vote.tieResolution === "no_effect"
      ? t("amendment.vote.alternatives.noEffect")
      : t("amendment.vote.alternatives.rejectedAll");
  }

  /** One line: what it was, the counts and what came of it. */
  function summary(vote: VoteDto): string {
    return [
      t("amendment.vote.alternatives.title"),
      counts(vote),
      outcome(vote),
    ].join(" · ");
  }

  return { isAlternatives, optionName, counts, outcome, summary };
}
