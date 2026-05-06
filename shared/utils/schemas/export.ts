import { z } from "zod/v4";

export const createExportSchema = z.object({
  locale: z.enum(["es", "en"]).default("es"),
});
