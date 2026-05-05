import { z } from "zod/v4";
import { ALL_ASSEMBLY_TYPES } from "../../constants/assemblyTypes";
import { ASSEMBLY_STATUSES } from "../../constants/statuses";

export const createAssemblySchema = z.object({
  number: z.number().int().min(1),
  type: z.enum(ALL_ASSEMBLY_TYPES as [string, ...string[]]),
  startDate: z.iso.datetime(),
  endDate: z.iso.datetime(),
  location: z.string().min(1).max(500),
});

export const updateAssemblySchema = z.object({
  number: z.number().int().min(1).optional(),
  type: z.enum(ALL_ASSEMBLY_TYPES as [string, ...string[]]).optional(),
  startDate: z.iso.datetime().optional(),
  endDate: z.iso.datetime().optional(),
  location: z.string().min(1).max(500).optional(),
  updatedAt: z.iso.datetime(),
});

export const updateAssemblyStatusSchema = z.object({
  status: z.enum([
    ASSEMBLY_STATUSES.DRAFT,
    ASSEMBLY_STATUSES.PROVISIONAL,
    ASSEMBLY_STATUSES.DEFINITIVE,
  ] as [string, ...string[]]),
  updatedAt: z.iso.datetime(),
});
