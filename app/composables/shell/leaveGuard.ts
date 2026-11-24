/**
 * Pure rule behind `useLeaveGuard`: no Vue or router APIs here, so it is
 * unit-tested on its own (leaveGuard.test.ts).
 *
 * Every export is auto-imported app-wide (`imports.dirs: composables/**`),
 * hence the explicit name.
 */

/** The part of a route the rule reads. */
export interface LeaveGuardRouteLocation {
  path: string;
}

/**
 * Whether a navigation that keeps the same page (vue-router's update
 * guards) still takes the reader away from the work on the page. Another
 * document of the same assembly is the same route record with other params
 * ("Anterior", "Siguiente", the breadcrumbs, "atrás"), and Nuxt mounts the
 * page again for it: that leaves. A change of the query alone (`?enmienda=`
 * replaced as an amendment opens, a filter of an admin page) stays.
 */
export function routeUpdateLeavesPage(
  to: LeaveGuardRouteLocation,
  from: LeaveGuardRouteLocation,
): boolean {
  return to.path !== from.path;
}
