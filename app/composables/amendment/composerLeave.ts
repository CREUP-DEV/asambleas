/**
 * Pure rule behind `useComposerLeaveGuard`: no Vue or router APIs here, so it
 * is unit-tested on its own (composerLeave.test.ts).
 *
 * Every export is auto-imported app-wide (`imports.dirs: composables/**`),
 * hence the explicit name.
 */

/** The part of a route the rule reads. */
export interface ComposerRouteLocation {
  path: string;
}

/**
 * Whether a navigation that keeps the same page (vue-router's update
 * guards) still takes the reader away from the composer. Another document of
 * the same assembly is the same route record with other params ("Anterior",
 * "Siguiente", the breadcrumbs, "atrás"), and Nuxt mounts the page again for
 * it: that leaves. A change of the query alone (`?enmienda=` replaced as an
 * amendment opens) stays on this text.
 */
export function composerRouteUpdateLeaves(
  to: ComposerRouteLocation,
  from: ComposerRouteLocation,
): boolean {
  return to.path !== from.path;
}
