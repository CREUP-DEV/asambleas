import { z } from "zod/v4";

export const createPlatformDocumentSchema = z.object({
  title: z.string().min(1).max(500),
  content: z.string().min(1),
});

export const createPdfDocumentSchema = z.object({
  title: z.string().min(1).max(500),
  fileUrl: z.string().regex(/^\/uploads\/documents\/[a-f0-9-]+\.pdf$/),
});

export const updatePlatformDocumentSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  content: z.string().min(1).optional(),
  updatedAt: z.iso.datetime(),
});

export const updatePdfDocumentSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  fileUrl: z
    .string()
    .regex(/^\/uploads\/documents\/[a-f0-9-]+\.pdf$/)
    .optional(),
  updatedAt: z.iso.datetime(),
});

export const updateDocumentStatusSchema = z.object({
  status: z.enum(["pending_review", "accepted"]),
  proponentId: z.string().nullable().optional(),
  updatedAt: z.iso.datetime(),
});
