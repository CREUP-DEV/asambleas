import type { AssemblyType } from "./assemblyTypes";
import { PERMISSION_KEYS } from "./permissions";
import type { CalendarRules } from "../utils/calendar";

/**
 * Who reads and edits the calendar rules of the assembly types (GET and
 * PUT /api/calendar-rules, the admin page /admin/calendario): whoever
 * manages assemblies and their calendars. One constant, so moving it to
 * another key is a one-line change.
 */
export const CALENDAR_RULES_PERMISSION = PERMISSION_KEYS.ASSEMBLY_MANAGE;

/**
 * The calendar rules `pnpm db:seed` stores for a type that has none, read
 * from the RRI and RFAG approved at the 33.ª AGET (14/10/2026), base text
 * without the suggestions left pending in that consolidated version. They
 * are only a bootstrap: the rules in force live in `calendar_rules` and are
 * edited in the admin section; the server falls back to these (with a
 * warning) only while a type has no stored row, and the first save from the
 * admin page stores one.
 *
 * Minimums (the latest each milestone may fall):
 * - convocation: 1 month for an AGO and 15 natural days for an AGE (RRI
 *   art. 19, Estatutos art. 15.2); a telematic AGE may be convened with less
 *   than 15 but never under 5 natural days, ratified before the session
 *   (RRI art. 19, second paragraph);
 * - agenda_final: 14 natural days for an AGO, 7 for an AGE (RFAG art. 7.1);
 * - documents_publish: documents to be voted, 12 natural days for an AGO, 5
 *   for an extraordinary session (RFAG art. 21.1);
 * - documents_close: internal motions and resolutions, 8 natural days for an
 *   AGO, 5 for an extraordinary session (RFAG art. 21.1);
 * - amendments_close: 72 hours, the latest the Comisión Ejecutiva may extend
 *   the window to (RFAG art. 23.4; it closes 4 natural days before by
 *   default, art. 23.3);
 * - candidacies_close: 96 hours before the start (RRI art. 55.1).
 *
 * Defaults are those minimums where the regulations fix the date, plus
 * usual practice where the Comisión Ejecutiva sets it (agenda requests,
 * opening of the amendment window: docs/proceso-asambleas.md §3).
 * No reform window minimum: RRI 2026 art. 84.1 gives it "el mismo [plazo]
 * que para el resto de documentación" (RRI 2025 art. 65.3 said 12 days).
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
    regulationWindowDays: null,
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
    regulationWindowDays: null,
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
      convocation: { days: 5 },
      agenda_final: { days: 7 },
      documents_publish: { days: 5 },
      documents_close: { days: 5 },
      amendments_close: { hours: 72 },
      candidacies_close: { hours: 96 },
    },
    regulationWindowDays: null,
  },
};
