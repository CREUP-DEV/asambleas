import type { ComputedRef, MaybeRefOrGetter } from "vue";
import type { HeadcountDto, VoteInput } from "~~/shared/types/api";
import type { AssemblySettings } from "~~/shared/constants/domain";
import { formatMoment } from "~/utils/format";
import { useAppNow } from "../time/useAppNow";
import { sessionFillPresent, sessionVoteOutcome } from "./sessionModel";

/**
 * The base a vote's result is counted on, for the confirmation step of the
 * vote dialogs: "Base de cálculo: 40 miembros presentes", with the count's
 * day when the base is a count taken another day (Europe/Madrid). An empty
 * "present" counts on the latest headcount, as on the server
 * (sessionFillPresent).
 */
export function useVoteBaseText(
  vote: MaybeRefOrGetter<VoteInput>,
  settings: MaybeRefOrGetter<Pick<AssemblySettings, "denominator" | "tieRule">>,
  headcount: MaybeRefOrGetter<HeadcountDto | null | undefined>,
): ComputedRef<string> {
  const { t, locale } = useI18n();
  const now = useAppNow();
  return computed(() => {
    const input = toValue(vote);
    const current = toValue(settings);
    const latest = toValue(headcount);
    const counted = sessionFillPresent(input, latest, current);
    const outcome = sessionVoteOutcome(input, current, latest);
    const onPresent =
      current.denominator === "present" && counted.present != null;
    const text = t("session.vote.denominator", {
      count: outcome.denominator,
      base: onPresent
        ? t("session.vote.denominatorPresent")
        : t("session.vote.denominatorValid"),
    });
    if (!onPresent || !latest || counted.present !== latest.present) {
      return text;
    }
    const taken = formatMoment(latest.takenAt, {
      locale: locale.value,
      now: now.value,
    });
    return taken.today
      ? text
      : `${text} · ${t("session.vote.countMoment", { moment: taken.text })}`;
  });
}
