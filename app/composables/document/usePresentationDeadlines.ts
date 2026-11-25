import type { MaybeRefOrGetter } from "vue";
import type { DocumentKind, MilestoneKey } from "~~/shared/constants/domain";
import type { AssemblyDto } from "~~/shared/types/api";
import {
  closingPresentationSchedule,
  presentationDeadlinePassed,
  presentationSchedule,
} from "~~/shared/utils/documentDeadline";

/**
 * Members' presentation deadlines on the shared clock (useAppNow), so what
 * hangs on them changes on time in a tab left open: whether a kind is still
 * in its own deadline (`kindOpen`, presentationDeadlinePassed, the rule the
 * server applies to creating a document, sending it and changing its kind or
 * item; always for a report)
 * and the deadlines across `kinds` (`schedule`, presentationSchedule; every
 * kind when none are given, or an empty list while they are not known).
 * `closingSchedule` reads the same kinds but only those that close
 * (closingPresentationSchedule), for a notice that says presentation is
 * over: `schedule` never closes with reports among the kinds, so it decides
 * whether anything may still be presented, and `closingSchedule` what to
 * say about the deadlines. Reads the current assembly unless given one.
 * Expected documents are not bound by these deadlines: the caller exempts
 * them.
 */
export function usePresentationDeadlines(
  source?: MaybeRefOrGetter<Pick<AssemblyDto, "milestones"> | null | undefined>,
  kinds?: MaybeRefOrGetter<readonly DocumentKind[] | null | undefined>,
) {
  const assembly = source ?? useCurrentAssembly().assembly;
  const now = useAppNow();

  function milestoneAt(key: MilestoneKey): string | undefined {
    return toValue(assembly)?.milestones.find(
      (milestone) => milestone.key === key,
    )?.at;
  }

  /** Whether members may still present a document of this kind. */
  function kindOpen(kind: DocumentKind): boolean {
    return !presentationDeadlinePassed(kind, milestoneAt, new Date(now.value));
  }

  const schedule = computed(() => {
    const scope = toValue(kinds);
    return presentationSchedule(
      milestoneAt,
      new Date(now.value),
      scope?.length ? scope : undefined,
    );
  });

  const closingSchedule = computed(() => {
    const scope = toValue(kinds);
    return closingPresentationSchedule(
      milestoneAt,
      new Date(now.value),
      scope?.length ? scope : undefined,
    );
  });

  return { kindOpen, schedule, closingSchedule };
}
