import type { AmendmentDto } from "~~/shared/types/api";
import {
  sessionTransactionalRejectors,
  type SessionAmendmentStage,
} from "./sessionModel";

/**
 * One short status for an amendment in the console: where it stands in the
 * session while undecided, how it got into the text without a vote, or its
 * final status. A transactional a main author turned down names who did
 * ("Rechazada por CAUB"). Shared by the queue rows and the announcement of
 * "Ahora en debate".
 */
export function useSessionStageLabel() {
  const { t } = useI18n();

  return (stage: SessionAmendmentStage, amendment: AmendmentDto): string => {
    switch (stage) {
      case "turned_down":
        return t("session.stage.turned_down", {
          members: sessionTransactionalRejectors(amendment)
            .map((member) => member.acronym)
            .join(", "),
        });
      case "closed":
      case "superseded":
      case "awaiting_authors":
      case "awaiting_validation":
      case "correction_requested":
      case "late":
      case "acceptances":
      case "open":
      case "incorporated":
        return t(`session.stage.${stage}`);
      default:
        return t(`common.status.amendment.${stage}`);
    }
  };
}
