export const ASSEMBLY_STATUSES = {
  DRAFT: "draft",
  PROVISIONAL: "provisional",
  DEFINITIVE: "definitive",
} as const;

export type AssemblyStatus =
  (typeof ASSEMBLY_STATUSES)[keyof typeof ASSEMBLY_STATUSES];

export const ASSEMBLY_STATUS_TRANSITIONS: Record<
  AssemblyStatus,
  AssemblyStatus[]
> = {
  [ASSEMBLY_STATUSES.DRAFT]: [ASSEMBLY_STATUSES.PROVISIONAL],
  [ASSEMBLY_STATUSES.PROVISIONAL]: [
    ASSEMBLY_STATUSES.DRAFT,
    ASSEMBLY_STATUSES.DEFINITIVE,
  ],
  [ASSEMBLY_STATUSES.DEFINITIVE]: [ASSEMBLY_STATUSES.PROVISIONAL],
};

export const DOCUMENT_STATUSES = {
  DRAFT: "draft",
  PENDING_REVIEW: "pending_review",
  ACCEPTED: "accepted",
} as const;

export type DocumentStatus =
  (typeof DOCUMENT_STATUSES)[keyof typeof DOCUMENT_STATUSES];

export const AMENDMENT_STATUSES = {
  DRAFT: "draft",
  PENDING_REVIEW: "pending_review",
  REJECTED_SECRETARIA: "rejected_secretaria",
  FORMAL: "formal",
  ACCEPTED_SECRETARIA: "accepted_secretaria",
  ACCEPTED_PROPONENT: "accepted_proponent",
  REJECTED_PROPONENT: "rejected_proponent",
  APPROVED_VOTE: "approved_vote",
  REJECTED_VOTE: "rejected_vote",
} as const;

export type AmendmentStatus =
  (typeof AMENDMENT_STATUSES)[keyof typeof AMENDMENT_STATUSES];

export const AMENDMENT_INCORPORATED_STATUSES: AmendmentStatus[] = [
  AMENDMENT_STATUSES.FORMAL,
  AMENDMENT_STATUSES.ACCEPTED_PROPONENT,
  AMENDMENT_STATUSES.APPROVED_VOTE,
];
