import type { SessionFinalVoteReason } from "./sessionModel";

/**
 * Puts a reason that blocks the final vote into words, saying who has to
 * act. Shared by the console's "Ahora en debate" and the consolidated text.
 * `label` turns an amendment id into its code.
 */
export function useFinalVoteReasonText(label: (id: string) => string) {
  const { t } = useI18n();

  return (reason: SessionFinalVoteReason): string => {
    switch (reason.key) {
      case "notVoted":
        return t("session.preview.notVoted");
      case "notPublished":
        return t("session.preview.notPublished");
      case "amendmentsLoading":
        return t("session.preview.amendmentsLoading");
      case "totalityReturn":
        return t("session.preview.totalityReturnBlocked", {
          code: label(reason.id),
        });
      case "undecided":
        return t(
          "session.preview.undecided",
          { count: reason.count },
          reason.count,
        );
      case "awaitingValidation":
        return t(
          "session.preview.awaitingValidation",
          { count: reason.count },
          reason.count,
        );
      case "awaitingProponent":
        return t(
          "session.preview.awaitingProponent",
          { count: reason.count },
          reason.count,
        );
      case "proponentRejected":
        return t(
          "session.preview.proponentRejected",
          { count: reason.count },
          reason.count,
        );
    }
  };
}
