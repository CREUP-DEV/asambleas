import type { MeDto, MemberRef } from "~~/shared/types/api";
import type { PermissionKey } from "~~/shared/constants/permissions";
import { errorStatus } from "../api/useApi";

/** One in-flight /api/me request per Nuxt app (i.e. per SSR request). */
const inflight = new WeakMap<object, Promise<MeDto | null>>();

const ME_STATE_KEY = "me";
const ME_LOADED_KEY = "me-loaded";

/**
 * The signed-in user, their permissions and the member they act for, from
 * GET /api/me. The global auth middleware loads it once per session; pages
 * read it from shared state. `refresh()` reloads it after a role change.
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

  function can(permission: PermissionKey): boolean {
    if (!me.value) return false;
    return me.value.isAdmin || me.value.permissions.includes(permission);
  }

  /** Reloads /api/me. Never throws: on failure the state is left signed out. */
  function refresh(): Promise<MeDto | null> {
    const pending = inflight.get(nuxtApp);
    if (pending) return pending;

    const request = (async () => {
      try {
        const data = await requestFetch<MeDto>("/api/me");
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
    permissions,
    can,
    refresh,
    ensure,
    clear,
  };
}
