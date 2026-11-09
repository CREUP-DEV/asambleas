import type { AssemblyType } from "./assemblyTypes";
import { PERMISSION_KEYS } from "./permissions";
import type { CalendarRules } from "../utils/calendar";
import type { QuorumRules } from "../utils/headcount";

/**
 * Who reads and edits the calendar rules of the assembly types (GET and
 * PUT /api/calendar-rules, the admin page /admin/calendario): whoever
 * manages assemblies and their calendars. One constant, so moving it to
 * another key is a one-line change.
 */
export const CALENDAR_RULES_PERMISSION = PERMISSION_KEYS.ASSEMBLY_MANAGE;

/**
 * The calendar rules `pnpm db:seed` stores for a type that has none, read
 * from the rules in force: the Estatutos (34.ª AGE, 2024) and the RRI and
 * RFAG as last modified at the 28.ª AGET (10/10/2025). The texts prepared
 * for the 33.ª AGET (2026) were never approved and do not apply. These are
 * only a bootstrap: the rules in force live in `calendar_rules` and are
 * edited in the admin section; the server falls back to these (with a
 * warning) only while a type has no stored row, and the first save from the
 * admin page stores one. Days are natural days.
 *
 * Minimums (the latest each milestone may fall):
 * - convocation: 1 month for an AGO and 15 days for an AGE (Estatutos art.
 *   15.2, RRI art. 11.2); a telematic AGE may exceptionally be convened with
 *   less, never under 4 days, ratified by that assembly (RRI art. 11.2);
 * - agenda_final: 14 days for an AGO, 7 for an AGE (RRI art. 12.3);
 * - documents_publish: documents to be voted, 12 days for an AGO, 5 for an
 *   extraordinary session (RRI art. 13.1, RFAG art. 10.1);
 * - documents_close: internal motions and resolutions, 8 days for an AGO, 5
 *   for an extraordinary session (same articles);
 * - amendments_close: 72 hours, the latest the Comisión Ejecutiva may extend
 *   the window to (RFAG art. 20.2; it closes 4 days before by default, art.
 *   20.1);
 * - candidacies_close: 96 hours before the start (RRI art. 41.1).
 *
 * An extraordinary assembly convened with less than 5 days must send every
 * document with the convocation (RRI art. 13.1.a, RFAG art. 10.1.a). A
 * reform of the Estatutos or a regulation needs an amendment window of at
 * least 12 days (RRI art. 65.3).
 *
 * Quorum is counted on the members of the association, the active
 * asociados at the time of the count, delegated votes included (RRI art.
 * 19.3):
 * - AGO: at least half in the first call (Estatutos art. 14.1, RFAG art.
 *   9.1, RRI art. 10.3), at least a third in the second;
 * - AGE and AGET: a single call, more than half (Estatutos art. 14.2, which
 *   prevails over the "como mínimo" of RRI art. 10.4 and RFAG art. 9.2).
 * The Presidencia and the Secretaría Ejecutiva, or whoever stands in for
 * them, must also be present; the headcount does not check that.
 *
 * Defaults are those minimums where the regulations fix the date, plus
 * usual practice where the Comisión Ejecutiva sets it (agenda requests,
 * submission deadlines, opening of the amendment window:
 * docs/proceso-asambleas.md §3).
 */
export const INITIAL_CALENDAR_RULES: Record<AssemblyType, CalendarRules> = {
  AGO: {
    defaults: {
      convocation: { months: 1 },
      agenda_requests_close: { days: 21 },
      agenda_final: { days: 14 },
      documents_publish: { days: 12 },
      amendments_open: { days: 12 },
      documents_close: { days: 8 },
      amendments_close: { days: 4 },
      candidacies_close: { hours: 96 },
    },
    minimums: {
      convocation: { months: 1 },
      agenda_final: { days: 14 },
      documents_publish: { days: 12 },
      documents_close: { days: 8 },
      amendments_close: { hours: 72 },
      candidacies_close: { hours: 96 },
    },
    documentsWithConvocationBelow: null,
    regulationWindowDays: 12,
    quorum: {
      firstCall: { numerator: 1, denominator: 2, strict: false },
      secondCall: { numerator: 1, denominator: 3, strict: false },
    },
  },
  AGE: {
    defaults: {
      convocation: { days: 15 },
      agenda_final: { days: 7 },
      documents_close: { days: 7 },
      documents_publish: { days: 5 },
      amendments_open: { days: 5 },
      amendments_close: { days: 4 },
      candidacies_close: { hours: 96 },
    },
    minimums: {
      convocation: { days: 15 },
      agenda_final: { days: 7 },
      documents_publish: { days: 5 },
      documents_close: { days: 5 },
      amendments_close: { hours: 72 },
      candidacies_close: { hours: 96 },
    },
    documentsWithConvocationBelow: { days: 5 },
    regulationWindowDays: 12,
    quorum: {
      firstCall: { numerator: 1, denominator: 2, strict: true },
      secondCall: null,
    },
  },
  AGET: {
    defaults: {
      convocation: { days: 7 },
      agenda_final: { days: 7 },
      documents_close: { days: 6 },
      documents_publish: { days: 5 },
      amendments_open: { days: 5 },
      amendments_close: { days: 4 },
    },
    minimums: {
      convocation: { days: 4 },
      agenda_final: { days: 7 },
      documents_publish: { days: 5 },
      documents_close: { days: 5 },
      amendments_close: { hours: 72 },
      candidacies_close: { hours: 96 },
    },
    documentsWithConvocationBelow: { days: 5 },
    regulationWindowDays: 12,
    quorum: {
      firstCall: { numerator: 1, denominator: 2, strict: true },
      secondCall: null,
    },
  },
};

/**
 * The quorum of a type's rules; rows stored before quorum was part of them
 * fall back to the initial rules of the type.
 */
export function quorumRulesOf(
  type: AssemblyType,
  rules: CalendarRules,
): QuorumRules {
  return rules.quorum ?? INITIAL_CALENDAR_RULES[type].quorum!;
}
