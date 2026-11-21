import { thirdCount, voteTextKey } from "~~/shared/utils/votes";
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
  const electionText = useElectionText();

  /** An election: who was elected (or the second round) and how. */
  function electionLine(vote: VoteDto): string | null {
    if (!vote.election) return null;
    return [
      electionText.outcome(vote.election),
      t(`session.enums.voteMethod.${vote.method}`),
    ].join(" · ");
  }

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
    // In favour, against and abstentions (blank in a secret vote), in that
    // order: the Mesa's own shorthand, the same in every language.
    return (
      electionLine(vote) ??
      assentLine(vote) ??
      [
        result(vote),
        t(`session.enums.voteMethod.${vote.method}`),
        `${vote.inFavor} / ${vote.against} / ${thirdCount(vote)}`,
      ].join(" · ")
    );
  }

  function spoken(vote: VoteDto): string {
    return (
      electionLine(vote) ??
      assentLine(vote) ??
      t(voteTextKey("session.itemVote.status.spoken", vote.method), {
        result: result(vote),
        method: t(`session.enums.voteMethod.${vote.method}`),
        inFavor: vote.inFavor,
        against: vote.against,
        abstentions: vote.abstentions,
        blank: vote.blank,
      })
    );
  }

  return { line, spoken };
}
