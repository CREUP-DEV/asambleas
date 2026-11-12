import type { Ref } from "vue";
import type { AmendmentDto } from "~~/shared/types/api";
import {
  sessionPendingTransactionalIds,
  sessionTransactionalWaitsFor,
} from "./sessionModel";

/**
 * The pending transactionals over an amendment, in words, for the Mesa
 * console (SES-3): settling the amendment in any way withdraws them on the
 * server (sessionPendingTransactionalIds), so "Ahora en debate", the vote,
 * admission and bulk assent dialogs and the confirmation of one-click
 * decisions name them and who they wait for: "T9, espera a UPV". A
 * transactional not published yet has no code and reads "Sin número".
 */
export function useSessionTransactionalsOver(
  byId: Readonly<Ref<ReadonlyMap<string, AmendmentDto>>>,
) {
  const { t } = useI18n();

  function codeOf(amendment: AmendmentDto): string {
    return amendment.code ?? t("amendment.unnumberedLabel");
  }

  /** The transactionals settling it would withdraw, loaded. */
  function pending(amendment: AmendmentDto): AmendmentDto[] {
    return sessionPendingTransactionalIds(amendment, byId.value)
      .map((id) => byId.value.get(id))
      .filter((other): other is AmendmentDto => other !== undefined);
  }

  /** "T9, espera a UPV", "T9, espera a la Secretaría" or "T9". */
  function entry(transactional: AmendmentDto): string {
    const code = codeOf(transactional);
    const waits = sessionTransactionalWaitsFor(transactional);
    if (waits.members.length > 0) {
      return t("session.transactionalOver.waitsFor", {
        code,
        members: waits.members.map((member) => member.acronym).join(", "),
      });
    }
    return waits.validation
      ? t("session.transactionalOver.waitsValidation", { code })
      : code;
  }

  /**
   * "Hay una transaccional en curso sobre ella: T9, espera a UPV.", or null
   * when there is none.
   */
  function line(amendment: AmendmentDto): string | null {
    const list = pending(amendment);
    if (list.length === 0) return null;
    return t(
      "session.transactionalOver.line",
      { list: list.map(entry).join("; "), count: list.length },
      list.length,
    );
  }

  /**
   * What a one-click decision does to them, for its confirmation: "Si
   * sigues, se retira T9. Si reabres UGR 3 antes de la votación final,
   * vuelve a estar en curso, siempre que no se haya decidido otra de las
   * enmiendas que agrupa." (reopenTransactionalsClosedBy on the server).
   * Null when there is none.
   */
  function consequence(amendment: AmendmentDto): string | null {
    const list = pending(amendment);
    if (list.length === 0) return null;
    return t(
      "session.transactionalOver.consequence",
      {
        codes: list.map(codeOf).join(", "),
        code: codeOf(amendment),
        count: list.length,
      },
      list.length,
    );
  }

  return { pending, line, consequence };
}
