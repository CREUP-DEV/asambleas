import SessionConfirmDialog from "~/components/session/ConfirmDialog.vue";
import type { SessionConfirmProps } from "./useSessionConsole";

/** What the question before losing the work says. */
export interface DirtyDialogQuestion {
  title: string;
  description: string;
}

/**
 * A console dialog that holds unsaved work (E-127/M-117): counted votes or
 * ballots, a roll call under way, a passage's wording. While `dirty` holds,
 * Escape and a click outside do nothing (`dismissible`), and the X and
 * «Cancelar», which close through the modal's `update:open`, ask first
 * with the console's own confirmation (SessionConfirmDialog). Bind it as
 * `:open="open" :dismissible="dismissible" @update:open="onOpenUpdate"`,
 * never `v-model:open`: a close after saving sets `open` itself and never
 * asks. A dialog outside the console may instead bind `@close:prevent` to
 * `onOpenUpdate(false)`, so Escape and a click outside ask too
 * (DocumentRecordDialog, a slideover edited like a page).
 *
 * `confirm` is the console's (`session.confirm`); a dialog used outside
 * the console (the wording dialog on the consolidated text) opens the same
 * confirmation through the overlay.
 */
export function useDirtyDialog(options: {
  /** The dialog's open state, set only once the work may go. */
  open: { value: boolean };
  dirty: () => boolean;
  question: () => DirtyDialogQuestion;
  confirm?: (props: SessionConfirmProps) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const overlay = options.confirm ? null : useOverlay();
  let asking = false;

  async function ask(question: DirtyDialogQuestion): Promise<boolean> {
    const props: SessionConfirmProps = {
      ...question,
      confirmLabel: t("common.discard"),
      confirmIcon: "i-lucide-trash-2",
      confirmColor: "warning",
    };
    if (options.confirm) return options.confirm(props);
    const modal = overlay!.create(SessionConfirmDialog, {
      destroyOnClose: true,
    });
    return (await modal.open(props)) === true;
  }

  /**
   * Whether the work may go: true at once when there is none, otherwise
   * the Mesa's answer to `question` (the close question by default). One
   * question at a time: another request meanwhile answers no.
   */
  async function discardAllowed(
    question: DirtyDialogQuestion = options.question(),
  ): Promise<boolean> {
    if (!options.dirty()) return true;
    if (asking) return false;
    asking = true;
    try {
      return await ask(question);
    } finally {
      asking = false;
    }
  }

  async function onOpenUpdate(value: boolean): Promise<void> {
    if (value || (await discardAllowed())) options.open.value = value;
  }

  const dismissible = computed(() => !options.dirty());

  return { dismissible, onOpenUpdate, discardAllowed };
}
