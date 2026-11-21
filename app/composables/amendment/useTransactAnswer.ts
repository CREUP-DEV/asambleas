import AmendmentTransactAnswerDialog from "~/components/amendment/TransactAnswerDialog.vue";
import type { TransactAnswerResult } from "./transactAnswer";

/** What the dialog says: the amendment, who answers, what is on its way. */
export interface TransactAnswerQuestion {
  code: string;
  /** The main presenter the Mesa answers for; null for a presenter. */
  mesaFor: string | null;
  pending: { id: string; label: string }[];
}

/**
 * The question asked when someone answers «Propone una transaccional»
 * where that answer is a step towards writing it (user's decision of
 * 2026-11-21): the control sheet's panel (ControlSheetPositionAnswer), the
 * workspace's answer (AmendmentPositionPanel) and the presenter's review
 * (revisar.vue). Whether to ask is transactAnswerLeads
 * (./transactAnswer.ts); each caller saves the answer and, on `draft` or
 * `open`, goes to the composer or the transactional its own way (the
 * workspace opens its composer in place: a link to the page it is on would
 * not). One question at a time: another one while it is open is cancelled.
 */
export function useTransactAnswer() {
  const overlay = useOverlay();
  const asking = ref(false);

  async function ask(
    question: TransactAnswerQuestion,
  ): Promise<TransactAnswerResult> {
    if (asking.value) return { action: "cancel" };
    asking.value = true;
    try {
      const modal = overlay.create(AmendmentTransactAnswerDialog, {
        destroyOnClose: true,
      });
      const result = (await modal.open(question)) as
        TransactAnswerResult | undefined | null;
      return result ?? { action: "cancel" };
    } finally {
      asking.value = false;
    }
  }

  return { ask, asking: readonly(asking) };
}
