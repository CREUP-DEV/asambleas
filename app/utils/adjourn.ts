/** How long before the assembly's end adjourning already means finishing. */
export const FINISH_WINDOW_MS = 60 * 60 * 1000;

/**
 * What «Levantar la sesión» offers first (user's decision of 2026-11-18):
 * that the session resumes later, unless the assembly's configured end is
 * less than an hour away or already past, when it finishes the assembly.
 * The Mesa can always pick the other.
 */
export function defaultAdjournChoice(
  endDate: string | null | undefined,
  now: number = Date.now(),
): "resume" | "finish" {
  const end = endDate ? new Date(endDate).getTime() : Number.NaN;
  if (!Number.isFinite(end)) return "resume";
  return now >= end - FINISH_WINDOW_MS ? "finish" : "resume";
}
