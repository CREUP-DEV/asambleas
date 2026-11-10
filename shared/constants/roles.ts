export const SYSTEM_ROLES = {
  ADMIN: "Admin",
  SECRETARIA: "Secretaría",
  MODERADOR: "Moderador",
  /** Presidency of CREUP: same default permissions as the Secretaría. */
  PRESIDENCIA: "Presidencia",
  /** Members of the Comisión Ejecutiva Ampliada (intranet type "CEA"). */
  CEA: "CEA",
  ASOCIADO: "Asociado",
  /**
   * Sectorial associations (intranet type "Sectorial"): they attend and
   * present documents and amendments like a council, but never an internal
   * motion (a rule of the member, shared/utils/presenterKinds.ts).
   */
  SECTORIAL: "Sectorial",
  /**
   * The role every other account gets (any other intranet type, or none):
   * it reads what is published and nothing else.
   */
  OTRO: "Otro",
  /**
   * Given here by hand, never by role sync: it reads like Otro, and the
   * Mesa marks it at the headcounts, as a guest without a vote.
   */
  INVITADO: "Invitado",
} as const;

export type SystemRoleName = (typeof SYSTEM_ROLES)[keyof typeof SYSTEM_ROLES];

export const SYSTEM_ROLE_NAMES = Object.values(SYSTEM_ROLES);

/** Roles that only read: the default one and the guests. */
export const READ_ONLY_ROLES: readonly SystemRoleName[] = [
  SYSTEM_ROLES.OTRO,
  SYSTEM_ROLES.INVITADO,
];

export function isReadOnlyRole(name: string | null | undefined): boolean {
  return (READ_ONLY_ROLES as readonly string[]).includes(name ?? "");
}

export const PROTECTED_ROLES: readonly SystemRoleName[] = [
  SYSTEM_ROLES.ADMIN,
  SYSTEM_ROLES.SECRETARIA,
  SYSTEM_ROLES.PRESIDENCIA,
  SYSTEM_ROLES.MODERADOR,
];
