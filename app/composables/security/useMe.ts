import type { MeDto, MeImpersonationDto, MemberRef } from "~~/shared/types/api";
import {
  holdsPermission,
  type PermissionKey,
} from "~~/shared/constants/permissions";
import { errorStatus } from "../api/useApi";

/**
 * Whether `next` (a fresh GET /api/me) is another account, or the same one
 * under another impersonation, than the page was built for (`previous`).
 * Then the page must reload: switching the shared state under it would
 * make every later mutation carry the new account in `x-acting-user`, so
 * the server would accept writes from forms and data loaded for the old
 * one. Nothing known on either side is not a change: the first load, or a
 * session that ended (the auth middleware sends that one to /login).
 */
export function meIdentityChanged(
  previous: Pick<MeDto, "id" | "impersonation"> | null | undefined,
  next: Pick<MeDto, "id" | "impersonation"> | null | undefined,
): boolean {
  if (!previous || !next) return false;
  return (
    previous.id !== next.id ||
    (previous.impersonation?.id ?? null) !== (next.impersonation?.id ?? null)
  );
}

type MePermissions = Pick<MeDto, "isAdmin" | "permissions">;

/** Whether `me` was granted `key` as such; nobody signed in holds nothing. */
export function meGranted(
  me: MePermissions | null | undefined,
  key: PermissionKey,
): boolean {
  if (!me) return false;
  return me.isAdmin || me.permissions.includes(key);
}

/**
 * Whether `me` holds `key`, itself or through a key that implies it
 * (holdsPermission), as the server's rules read it.
 */
export function meCan(
  me: MePermissions | null | undefined,
  key: PermissionKey,
): boolean {
  return holdsPermission((granted) => meGranted(me, granted), key);
}

/** One in-flight /api/me request per Nuxt app (i.e. per SSR request). */
const inflight = new WeakMap<object, Promise<MeDto | null>>();

const ME_STATE_KEY = "me";
const ME_LOADED_KEY = "me-loaded";

/**
 * The signed-in user, their permissions and the member they act for, from
 * GET /api/me. The global auth middleware loads it once per session; pages
 * read it from shared state. `refresh()` reloads it after a role change.
 *
 * While an Admin acts as another account, everything here is that
 * account's and `impersonation` names the Admin (the banner and the user
 * menu read it). Identity comes only from here, never from better-auth's
 * own session, which keeps reporting the Admin. In the browser, a refresh
 * that finds another account or impersonation (one started or stopped in
 * another tab) leaves the state alone and reloads the page
 * (meIdentityChanged).
 *
 * Permission checks here only drive the UI. The server checks again.
 */
export function useMe() {
  const nuxtApp = useNuxtApp();
  const requestFetch = useRequestFetch();
  const me = useState<MeDto | null>(ME_STATE_KEY, () => null);
  const loaded = useState<boolean>(ME_LOADED_KEY, () => false);

  const isAdmin = computed(() => me.value?.isAdmin ?? false);
  const member = computed<MemberRef | null>(() => me.value?.member ?? null);
  const permissions = computed<PermissionKey[]>(
    () => me.value?.permissions ?? [],
  );
  /** The impersonation the page runs under, or null. */
  const impersonation = computed<MeImpersonationDto | null>(
    () => me.value?.impersonation ?? null,
  );

  /**
   * Whether the account reads the CEA offices as they are; otherwise the
   * server shows it the generic "CEA" everywhere.
   */
  const seesExecutiveMembers = computed(
    () => me.value?.seesExecutiveMembers ?? false,
  );

  /**
   * Whether the account holds `permission`, itself or through a key that
   * implies it (PERMISSION_IMPLIED_BY): what every check of the UI reads.
   */
  function can(permission: PermissionKey): boolean {
    return meCan(me.value, permission);
  }

  /**
   * Whether `permission` is granted as such, without implications: for the
   * grant rules of the admin panel, which the server checks against the
   * keys as granted (adminGrantViolation, `not_held`).
   */
  function granted(permission: PermissionKey): boolean {
    return meGranted(me.value, permission);
  }

  /**
   * Reloads /api/me. Never throws: on failure the state is left signed out.
   * When the account changed under the page, it resolves to the fresh
   * answer without storing it and reloads the page.
   */
  function refresh(): Promise<MeDto | null> {
    const pending = inflight.get(nuxtApp);
    if (pending) return pending;

    const request = (async () => {
      try {
        const data = await requestFetch<MeDto>("/api/me");
        if (import.meta.client && meIdentityChanged(me.value, data)) {
          reloadNuxtApp({ force: true });
          return data;
        }
        me.value = data;
        loaded.value = true;
      } catch (error) {
        const status = errorStatus(error);
        // Keep what we had on transient failures; drop it when the server
        // says the session is gone or the endpoint is unavailable.
        if (status === null || status >= 500) {
          if (!me.value) loaded.value = false;
        } else {
          me.value = null;
          loaded.value = false;
        }
      } finally {
        inflight.delete(nuxtApp);
      }
      return me.value;
    })();
    inflight.set(nuxtApp, request);
    return request;
  }

  /** Loads /api/me unless it is already loaded. */
  function ensure(): Promise<MeDto | null> {
    return loaded.value ? Promise.resolve(me.value) : refresh();
  }

  function clear(): void {
    me.value = null;
    loaded.value = false;
  }

  return {
    me: readonly(me),
    loaded: readonly(loaded),
    isAdmin,
    member,
    seesExecutiveMembers,
    permissions,
    impersonation,
    can,
    granted,
    refresh,
    ensure,
    clear,
  };
}
