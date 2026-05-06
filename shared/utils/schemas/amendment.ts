import { z } from "zod/v4";

export const createAmendmentSchema = z.object({
  content: z.string().min(1),
  justification: z.string().min(1).max(5000),
});

export const updateAmendmentSchema = z.object({
  content: z.string().min(1).optional(),
  justification: z.string().min(1).max(5000).optional(),
  updatedAt: z.iso.datetime(),
});

export const reviewAmendmentSchema = z.object({
  action: z.enum(["reject", "accept", "formal"]),
  updatedAt: z.iso.datetime(),
});

export const proponentDecisionSchema = z.object({
  action: z.enum(["accept", "reject"]),
  updatedAt: z.iso.datetime(),
});

export const voteResultSchema = z.object({
  result: z.enum(["approved", "rejected"]),
  updatedAt: z.iso.datetime(),
});

export const createTransactionalSchema = z.object({
  content: z.string().min(1),
  justification: z.string().min(1).max(5000),
});
