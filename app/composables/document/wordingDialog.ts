import type { AmendmentDto } from "~~/shared/types/api";
import type { AmendmentOp, Block } from "~~/shared/types/content";
import type {
  ApprovedConsolidation,
  Passage,
} from "~~/shared/utils/content/passages";

/**
 * What the wording dialog (SessionWordingDialog) reads and does, so the
 * same dialog serves the console (the Mesa words a passage before the
 * final vote) and the consolidated text page (a passage the final vote left
 * pending conciliation is conciliated, or proposed by its presenters; user's
 * decisions of 2026-11-21). The console's context fits it as it is.
 */
export interface WordingDialogContext {
  wordingDialog: { open: boolean; passageKey: string | null; editing: boolean };
  /** The approved text as it reads, with its passages. */
  preview: { readonly value: ApprovedConsolidation };
  amendments: { readonly value: readonly AmendmentDto[] };
  base: { readonly value: Block[] };
  busy: { readonly value: Record<string, boolean | undefined> };
  label: (amendmentId: string) => string;
  setWording: (
    passage: Pick<Passage, "amendmentIds" | "blockIds">,
    ops: AmendmentOp[],
  ) => Promise<boolean>;
  removeWording: (wordingId: string) => Promise<boolean>;
  /**
   * What saving does: the Mesa's wording (the console, the default), a
   * conciliation applied at once, or one proposed to the Secretaría.
   */
  purpose?: "mesa" | "conciliate" | "propose";
}
