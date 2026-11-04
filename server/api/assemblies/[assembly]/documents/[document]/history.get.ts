import { defineEventHandler } from "h3";
import {
  documentPositionsVisible,
  loadDocumentHistory,
  resolveDocumentRoute,
} from "../../../../../utils/domain/documents";
import { redactAmendmentEventPayload } from "../../../../../utils/domain/amendments";
import type { EventDto } from "~~/shared/types/api";

export default defineEventHandler(async (event): Promise<EventDto[]> => {
  const ctx = await resolveDocumentRoute(event);
  const positionsVisible = documentPositionsVisible(ctx);
  const history = await loadDocumentHistory(ctx);
  return history.map((entry) =>
    entry.entityType === "amendment"
      ? {
          ...entry,
          payload: redactAmendmentEventPayload(
            entry.type,
            entry.payload,
            positionsVisible,
          ),
        }
      : entry,
  );
});
