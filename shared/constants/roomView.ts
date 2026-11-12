/**
 * The room view: what an account that sees only what is public reads. The
 * projection sends it with every read it makes (`?view=room`), because it is
 * opened on a Mesa account but read by the whole room; the server honours it
 * only for the Mesa (session:moderate) and answers as that public account,
 * so the executive offices, the names of whoever speaks for one and
 * everything unpublished stay out of the answer (server/utils/domain/roomView.ts).
 */
export const ROOM_VIEW = "room" as const;

/** The query every read of the projection carries. */
export const ROOM_VIEW_QUERY = { view: ROOM_VIEW } as const;
