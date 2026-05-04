import type { PermissionKey } from "~~/shared/constants/permissions";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";

interface PermissionsResponse {
  permissions: PermissionKey[];
  role: string | null;
}

export const usePermissions = () => {
  const permissions = useState<PermissionKey[]>("user-permissions", () => []);
  const roleName = useState<string | null>("user-role", () => null);
  const loaded = useState("permissions-loaded", () => false);

  const fetchPermissions = async () => {
    try {
      const data = await $fetch<PermissionsResponse>("/api/auth/permissions", {
        headers: import.meta.server ? useRequestHeaders(["cookie"]) : undefined,
      });
      permissions.value = data.permissions;
      roleName.value = data.role;
      loaded.value = true;
    } catch {
      permissions.value = [];
      roleName.value = null;
      loaded.value = false;
    }
  };

  const hasPermission = (key: PermissionKey) => {
    if (roleName.value === SYSTEM_ROLES.ADMIN) return true;
    return permissions.value.includes(key);
  };

  const isAdmin = computed(() => roleName.value === SYSTEM_ROLES.ADMIN);
  const isSecretaria = computed(
    () => roleName.value === SYSTEM_ROLES.SECRETARIA,
  );
  const isAsociado = computed(() => roleName.value === SYSTEM_ROLES.ASOCIADO);
  const isInvitado = computed(() => roleName.value === SYSTEM_ROLES.INVITADO);
  const isModerador = computed(() => roleName.value === SYSTEM_ROLES.MODERADOR);

  return {
    permissions: readonly(permissions),
    roleName: readonly(roleName),
    loaded: readonly(loaded),
    fetchPermissions,
    hasPermission,
    isAdmin,
    isSecretaria,
    isAsociado,
    isInvitado,
    isModerador,
  };
};
