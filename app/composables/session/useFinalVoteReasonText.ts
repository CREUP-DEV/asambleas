import type { SessionFinalVoteReason } from "./sessionModel";

/**
 * Puts a reason that blocks the final vote into words, saying who has to
 * act. Shared by the console's "Ahora en debate" and the consolidated text.
 */
export function useFinalVoteReasonText() {
  const { t } = useI18n();

  return (reason: SessionFinalVoteReason): string => {
    switch (reason.key) {
      case "notVoted":
        return t("session.preview.notVoted");
      case "notPublished":
        return t("session.preview.notPublished");
      case "amendmentsLoading":
        return t("session.preview.amendmentsLoading");
      case "undecided":
      case "superseded":
      case "late":
      case "awaitingAuthors":
      case "awaitingValidation":
        return t(
          `session.preview.${reason.key}`,
          { count: reason.count },
          reason.count,
        );
    }
  };
}
