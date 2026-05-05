import { z } from "zod/v4";

export const createAgendaItemSchema = z.object({
  parentId: z.string().nullable().optional(),
  title: z.string().min(1).max(500),
  order: z.number().int().min(0).default(0),
  allowDocumentSubmission: z.boolean().default(false),
  documentSubmissionDeadline: z.iso.datetime().nullable().optional(),
  allowAmendments: z.boolean().default(false),
  amendmentDeadline: z.iso.datetime().nullable().optional(),
});

export const updateAgendaItemSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  allowDocumentSubmission: z.boolean().optional(),
  documentSubmissionDeadline: z.iso.datetime().nullable().optional(),
  allowAmendments: z.boolean().optional(),
  amendmentDeadline: z.iso.datetime().nullable().optional(),
  updatedAt: z.iso.datetime(),
});

export const reorderAgendaItemsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().min(1),
      order: z.number().int().min(0),
      parentId: z.string().nullable().optional(),
    }),
  ),
});
