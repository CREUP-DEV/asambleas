import type { SessionAmendmentStage } from "./sessionModel";

/**
 * One short status for an amendment in the console: where it stands in the
 * session while undecided, or its final status. Shared by the queue rows
 * and the announcement of "Ahora en debate".
 */
export function useSessionStageLabel() {
  const { t } = useI18n();

  return (stage: SessionAmendmentStage): string => {
    switch (stage) {
      case "awaiting_proponent":
      case "proponent_rejected":
      case "awaiting_validation":
      case "correction_requested":
      case "late":
      case "acceptances":
      case "open":
        return t(`session.stage.${stage}`);
      default:
        return t(`common.status.amendment.${stage}`);
    }
  };
}
