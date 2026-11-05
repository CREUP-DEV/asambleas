export const PERMISSION_KEYS = {
  USER_MANAGE_ROLES: "user:manage_roles",
  ROLE_MANAGE_PERMISSIONS: "role:manage_permissions",
  ASSEMBLY_CREATE: "assembly:create",
  ASSEMBLY_MANAGE: "assembly:manage",
  DOCUMENT_CREATE: "document:create",
  DOCUMENT_MANAGE: "document:manage",
  AMENDMENT_CREATE: "amendment:create",
  AMENDMENT_MANAGE: "amendment:manage",
  AMENDMENT_REVIEW: "amendment:review",
  ASSEMBLY_VOTE_RESULT: "assembly:vote_result",
  SESSION_MODERATE: "session:moderate",
  MEMBER_MANAGE: "member:manage",
} as const;

export type PermissionKey =
  (typeof PERMISSION_KEYS)[keyof typeof PERMISSION_KEYS];

export const ALL_PERMISSION_KEYS = Object.values(PERMISSION_KEYS);

export const PERMISSION_DESCRIPTION_I18N_KEYS: Record<PermissionKey, string> = {
  [PERMISSION_KEYS.USER_MANAGE_ROLES]:
    "permissions.descriptions.userManageRoles",
  [PERMISSION_KEYS.ROLE_MANAGE_PERMISSIONS]:
    "permissions.descriptions.roleManagePermissions",
  [PERMISSION_KEYS.ASSEMBLY_CREATE]: "permissions.descriptions.assemblyCreate",
  [PERMISSION_KEYS.ASSEMBLY_MANAGE]: "permissions.descriptions.assemblyManage",
  [PERMISSION_KEYS.DOCUMENT_CREATE]: "permissions.descriptions.documentCreate",
  [PERMISSION_KEYS.DOCUMENT_MANAGE]: "permissions.descriptions.documentManage",
  [PERMISSION_KEYS.AMENDMENT_CREATE]:
    "permissions.descriptions.amendmentCreate",
  [PERMISSION_KEYS.AMENDMENT_MANAGE]:
    "permissions.descriptions.amendmentManage",
  [PERMISSION_KEYS.AMENDMENT_REVIEW]:
    "permissions.descriptions.amendmentReview",
  [PERMISSION_KEYS.ASSEMBLY_VOTE_RESULT]:
    "permissions.descriptions.assemblyVoteResult",
  [PERMISSION_KEYS.SESSION_MODERATE]:
    "permissions.descriptions.sessionModerate",
  [PERMISSION_KEYS.MEMBER_MANAGE]: "permissions.descriptions.memberManage",
};

export const DEFAULT_ROLE_PERMISSIONS: Record<string, PermissionKey[]> = {
  Secretaría: [
    PERMISSION_KEYS.ASSEMBLY_CREATE,
    PERMISSION_KEYS.ASSEMBLY_MANAGE,
    PERMISSION_KEYS.DOCUMENT_CREATE,
    PERMISSION_KEYS.DOCUMENT_MANAGE,
    PERMISSION_KEYS.AMENDMENT_CREATE,
    PERMISSION_KEYS.AMENDMENT_MANAGE,
    PERMISSION_KEYS.AMENDMENT_REVIEW,
    PERMISSION_KEYS.ASSEMBLY_VOTE_RESULT,
    PERMISSION_KEYS.SESSION_MODERATE,
    PERMISSION_KEYS.MEMBER_MANAGE,
  ],
  Presidencia: [
    PERMISSION_KEYS.ASSEMBLY_CREATE,
    PERMISSION_KEYS.ASSEMBLY_MANAGE,
    PERMISSION_KEYS.DOCUMENT_CREATE,
    PERMISSION_KEYS.DOCUMENT_MANAGE,
    PERMISSION_KEYS.AMENDMENT_CREATE,
    PERMISSION_KEYS.AMENDMENT_MANAGE,
    PERMISSION_KEYS.AMENDMENT_REVIEW,
    PERMISSION_KEYS.ASSEMBLY_VOTE_RESULT,
    PERMISSION_KEYS.SESSION_MODERATE,
    PERMISSION_KEYS.MEMBER_MANAGE,
  ],
  CEA: [PERMISSION_KEYS.DOCUMENT_CREATE, PERMISSION_KEYS.AMENDMENT_CREATE],
  Asociado: [PERMISSION_KEYS.DOCUMENT_CREATE, PERMISSION_KEYS.AMENDMENT_CREATE],
  Moderador: [PERMISSION_KEYS.SESSION_MODERATE],
  Invitado: [],
};
