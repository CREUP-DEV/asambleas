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
  INVITADO: "Invitado",
} as const;

export type SystemRoleName = (typeof SYSTEM_ROLES)[keyof typeof SYSTEM_ROLES];

export const SYSTEM_ROLE_NAMES = Object.values(SYSTEM_ROLES);

export const PROTECTED_ROLES: readonly SystemRoleName[] = [
  SYSTEM_ROLES.ADMIN,
  SYSTEM_ROLES.SECRETARIA,
  SYSTEM_ROLES.PRESIDENCIA,
  SYSTEM_ROLES.MODERADOR,
];
