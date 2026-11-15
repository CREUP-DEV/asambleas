import type { VoteDto } from "~~/shared/types/api";

/**
 * How the console words the vote on an agenda item, about the item (el
 * punto, so «Aprobado», not the vote's «Aprobada»):
 *
 * - `line`, one line under the item: «Aprobado · Mano alzada · 30 / 2 / 1»,
 *   «Aprobado por asentimiento», «Aprobado por unanimidad»;
 * - `spoken`, the same for screen readers, with the counts named.
 */
export function useItemVoteText() {
  const { t } = useI18n();

  function result(vote: VoteDto): string {
    return vote.result === "approved"
      ? t("session.itemVote.status.approved")
      : t("session.itemVote.status.rejected");
  }

  function assentLine(vote: VoteDto): string | null {
    if (vote.method !== "assent") return null;
    return vote.unanimous
      ? t("session.itemVote.status.unanimous")
      : t("session.itemVote.status.assent");
  }

  function line(vote: VoteDto): string {
    // In favour, against and abstentions, in that order: the Mesa's own
    // shorthand, the same in every language.
    return (
      assentLine(vote) ??
      [
        result(vote),
        t(`session.enums.voteMethod.${vote.method}`),
        `${vote.inFavor} / ${vote.against} / ${vote.abstentions}`,
      ].join(" · ")
    );
  }

  function spoken(vote: VoteDto): string {
    return (
      assentLine(vote) ??
      t("session.itemVote.status.spoken", {
        result: result(vote),
        method: t(`session.enums.voteMethod.${vote.method}`),
        inFavor: vote.inFavor,
        against: vote.against,
        abstentions: vote.abstentions,
      })
    );
  }

  return { line, spoken };
}
