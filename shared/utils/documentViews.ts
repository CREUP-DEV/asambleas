/**
 * How long a published document was open (document_views): the page beats
 * every READING_BEAT_MS while it is visible and someone is at it, and the
 * server credits each beat no more than the time since the previous one.
 * Constants shared by the page and the server (recordDocumentReading).
 */

/** How often an open document reports the time it was read. */
export const READING_BEAT_MS = 30_000;

/** The most one beat may claim: a beat late by a whole interval still counts. */
export const READING_BEAT_MAX_SECONDS = 60;

/**
 * Without a key, a scroll, a pointer or a touch for this long, the reader is
 * taken as gone and the time stops counting.
 */
export const READING_IDLE_MS = 120_000;

/** Slack over the time since the last beat, for clocks and network delay. */
export const READING_SLACK_SECONDS = 5;
