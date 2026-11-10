import type { PermissionKey } from "~~/shared/constants/permissions";
import { SYSTEM_ROLES, isReadOnlyRole } from "~~/shared/constants/roles";

/**
 * Role and permission checks for the UI, built on `useMe` (GET /api/me).
 * Kept for the existing callers; new code can use `useMe` directly.
 */
export const usePermissions = () => {
  const { me, loaded, permissions, isAdmin, can, refresh, clear } = useMe();

  const roleName = computed(() => me.value?.role ?? null);

  /** Loads the permissions. Never throws, so it cannot break navigation. */
  const fetchPermissions = async (): Promise<void> => {
    await refresh();
  };

  const hasPermission = (key: PermissionKey) => can(key);

  const isSecretaria = computed(
    () => roleName.value === SYSTEM_ROLES.SECRETARIA,
  );
  const isAsociado = computed(() => roleName.value === SYSTEM_ROLES.ASOCIADO);
  /** Otro or Invitado: the account only reads. */
  const isReadOnly = computed(() => isReadOnlyRole(roleName.value));
  const isModerador = computed(() => roleName.value === SYSTEM_ROLES.MODERADOR);

  return {
    permissions,
    roleName,
    loaded,
    fetchPermissions,
    hasPermission,
    clear,
    isAdmin,
    isSecretaria,
    isAsociado,
    isReadOnly,
    isModerador,
  };
};
