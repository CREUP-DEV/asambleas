import {
  electionLeftToMesa,
  type ElectionRecord,
} from "~~/shared/utils/election";

/**
 * How an election reads (user's decisions of 2026-11-21): who was elected,
 * who goes to a second round, a tie the Mesa decides, and each candidate's
 * votes («Ana Pérez 12 · Luis Gil 8»). An election has no «a favor» nor
 * «en contra»: every place that words a vote's counts asks for
 * `vote.election` first.
 */
export function useElectionText() {
  const { t } = useI18n();

  function names(election: ElectionRecord, indexes: readonly number[]) {
    return indexes.map((index) => election.candidates[index] ?? "?").join(", ");
  }

  /** «Elegida: Ana Pérez», «Segunda vuelta: …», «Empate en el último puesto». */
  function outcome(election: ElectionRecord): string {
    const parts: string[] = [];
    if (election.elected.length > 0) {
      parts.push(
        t(
          "amendment.vote.election.elected",
          { names: names(election, election.elected) },
          election.elected.length,
        ),
      );
    }
    if (election.tie) parts.push(t("amendment.vote.election.tie"));
    if (electionLeftToMesa(election)) {
      parts.push(t("amendment.vote.election.leftToMesa"));
    }
    if (election.runoff && election.runoff.length > 0) {
      parts.push(
        t("amendment.vote.election.runoff", {
          names: names(election, election.runoff),
        }),
      );
    }
    if (parts.length === 0) parts.push(t("amendment.vote.election.nobody"));
    return parts.join(" · ");
  }

  /** The candidates, most voted first, with their votes and standing. */
  function rows(election: ElectionRecord) {
    return election.candidates
      .map((name, index) => ({
        index,
        name,
        count: election.counts[index] ?? 0,
        elected: election.elected.includes(index),
        runoff: election.runoff?.includes(index) ?? false,
      }))
      .sort((a, b) => b.count - a.count || a.index - b.index);
  }

  /** «Ana Pérez 12 · Luis Gil 8». */
  function counts(election: ElectionRecord): string {
    return rows(election)
      .map((row) => `${row.name} ${row.count}`)
      .join(" · ");
  }

  /** «Mayoría absoluta, segunda vuelta…» or «Mayoría simple», and the posts. */
  function rule(election: ElectionRecord): string {
    return t("amendment.vote.election.ruleLine", {
      rule: t(`session.election.rules.${election.rule}`),
      posts: election.posts,
    });
  }

  return { outcome, rows, counts, rule };
}
