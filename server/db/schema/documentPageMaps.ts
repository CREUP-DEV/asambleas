import {
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { PageMapStart } from "../../../shared/types/api";
import { documentVersions } from "./document";

/**
 * Where each printed page of a version's clean PDF starts (user's decisions
 * of 2026-11-21; server/utils/export/pageMap.ts), so the web text shows the
 * PDF's page numbers. Computed from the documentation package's own render
 * of that PDF, or by the `document-pages` job when the package has not
 * rendered it. Valid only while `layoutKey` matches the current inputs
 * (pageLayoutKey): a title or a vote edited moves the pages. Rebuildable:
 * the rows go with their version and nothing else reads them.
 */
export const documentPageMaps = pgTable(
  "document_page_maps",
  {
    versionId: text("version_id")
      .notNull()
      .references(() => documentVersions.id, { onDelete: "cascade" }),
    /** The PDF's language: only Spanish is computed. */
    locale: text("locale").notNull(),
    layoutKey: text("layout_key").notNull(),
    /** Printed pages, the cover uncounted. */
    totalPages: integer("total_pages").notNull(),
    starts: jsonb("starts").$type<PageMapStart[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [primaryKey({ columns: [table.versionId, table.locale] })],
);
