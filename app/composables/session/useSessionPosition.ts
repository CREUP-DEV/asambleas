import type { DropdownMenuItem } from "@nuxt/ui";
import { PROPONENT_POSITIONS } from "~~/shared/constants/domain";
import type { AmendmentDto } from "~~/shared/types/api";
import { isSessionPositionByMesa, sessionPositionMenu } from "./sessionModel";
import type { SessionConsole } from "./useSessionConsole";

const POSITION_ICONS = {
  pending: "i-lucide-circle-dashed",
  accept: "i-lucide-thumbs-up",
  reject: "i-lucide-thumbs-down",
  transact: "i-lucide-git-merge",
} as const;

/**
 * The answer of the document's main presenter in the console, shared by the
 * queue cards and "Ahora en debate":
 * - `label`: who gave the answer shown, "Respuesta de UPV:" or, when the
 *   Mesa recorded it, "La Mesa, en nombre de UPV:";
 * - `menuItem`: the "Más" entry that records the answer the main presenter
 *   gives in the room (sessionPositionMenu). Only published amendments are
 *   answered: a private one shows the entry disabled with the reason, and
 *   "La acepta" is disabled while accepting would put unpublished text into
 *   the document. Null when there is nothing to offer.
 * - `waitHint`: the same reason as a sentence for the card itself
 *   ("Respuesta de UPV: se podrá dar cuando Secretaría la publique."), since
 *   keyboards and screen readers skip a disabled menu entry. Null when
 *   nothing waits.
 */
export function useSessionPosition(session: SessionConsole) {
  const { t } = useI18n();

  /** The main presenter, by its acronym. */
  const presenter = computed(
    () =>
      session.document.value?.proponent?.acronym ??
      t("amendment.position.thePresenter"),
  );

  function label(amendment: AmendmentDto): string {
    return isSessionPositionByMesa(amendment.position)
      ? t("session.position.byMesa", { member: presenter.value })
      : t("session.position.by", { member: presenter.value });
  }

  function menuOf(amendment: AmendmentDto) {
    const document = session.document.value;
    return sessionPositionMenu(
      amendment,
      document?.acceptedAmendments ?? "vote",
      Boolean(document?.finalVote),
    );
  }

  function waitHint(amendment: AmendmentDto): string | null {
    return menuOf(amendment)?.waitsPublication
      ? t("session.position.waitsPublicationFor", { member: presenter.value })
      : null;
  }

  function menuItem(amendment: AmendmentDto): DropdownMenuItem | null {
    const menu = menuOf(amendment);
    if (!menu) return null;
    const waiting = t("session.position.waitsPublication");
    if (menu.waitsPublication) {
      return {
        label: t("amendment.position.title"),
        description: waiting,
        icon: "i-lucide-user-round-check",
        disabled: true,
      };
    }
    const current = amendment.position?.position ?? "pending";
    return {
      label: t("amendment.position.title"),
      icon: "i-lucide-user-round-check",
      children: PROPONENT_POSITIONS.map((position) => {
        const blocked = position === "accept" && menu.acceptBlocked;
        return {
          type: "checkbox" as const,
          label: t(`amendment.position.options.${position}`),
          description: blocked ? waiting : undefined,
          icon: POSITION_ICONS[position],
          checked: current === position,
          disabled: blocked,
          onSelect: () => {
            if (current !== position && !blocked) {
              void session.setPosition(amendment, position);
            }
          },
        };
      }),
    };
  }

  return { label, menuItem, waitHint };
}
