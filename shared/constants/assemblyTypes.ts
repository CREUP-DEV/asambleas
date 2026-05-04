export const ASSEMBLY_TYPES = {
  AGO: "AGO",
  AGE: "AGE",
  AGET: "AGET",
} as const;

export type AssemblyType = (typeof ASSEMBLY_TYPES)[keyof typeof ASSEMBLY_TYPES];

export const ALL_ASSEMBLY_TYPES = Object.values(ASSEMBLY_TYPES);
