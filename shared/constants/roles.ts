export const SYSTEM_ROLES = {
  ADMIN: "Admin",
  SECRETARIA: "Secretaría",
  MODERADOR: "Moderador",
  ASOCIADO: "Asociado",
  INVITADO: "Invitado",
} as const;

export type SystemRoleName = (typeof SYSTEM_ROLES)[keyof typeof SYSTEM_ROLES];

export const SYSTEM_ROLE_NAMES = Object.values(SYSTEM_ROLES);

export const PROTECTED_ROLES: readonly SystemRoleName[] = [
  SYSTEM_ROLES.ADMIN,
  SYSTEM_ROLES.SECRETARIA,
  SYSTEM_ROLES.MODERADOR,
];
