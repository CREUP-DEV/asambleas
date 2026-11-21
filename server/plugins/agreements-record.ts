import { subscribeToAll } from "../utils/live/hub";
import { logError } from "../utils/core/logger";
import { regenerateAgreementsRecord } from "../utils/domain/agreementsRecord";
import type { LiveMessage } from "../utils/domain/events";

/**
 * Keeps each assembly's acta de acuerdos (server/utils/domain/
 * agreementsRecord.ts) in step with its votes: every committed change that
 * may touch what it says (a vote, a decision, a document, the agenda, the
 * assembly) writes it again after a quiet spell, so a burst of votes writes
 * it once. Writing it is itself a document change, which comes back here
 * and finds the text the same. One app container (as the live hub), so the
 * timers live in memory.
 */

/** What may change an agreement. */
const RECORD_ENTITIES = new Set<LiveMessage["entityType"]>([
  "assembly",
  "agenda_item",
  "document",
  "vote",
  "decision",
]);

/** The quiet spell before writing. */
const REGENERATE_DELAY_MS = 1_500;

const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** Assemblies being written now, and those changed meanwhile. */
const running = new Set<string>();
const again = new Set<string>();

function schedule(assemblyId: string): void {
  clearTimeout(timers.get(assemblyId));
  const timer = setTimeout(() => {
    timers.delete(assemblyId);
    void run(assemblyId);
  }, REGENERATE_DELAY_MS);
  timer.unref?.();
  timers.set(assemblyId, timer);
}

async function run(assemblyId: string): Promise<void> {
  if (running.has(assemblyId)) {
    again.add(assemblyId);
    return;
  }
  running.add(assemblyId);
  try {
    await regenerateAgreementsRecord(assemblyId);
  } catch (error) {
    logError("agreementsRecord.regenerate", error);
  } finally {
    running.delete(assemblyId);
    if (again.delete(assemblyId)) schedule(assemblyId);
  }
}

function onMessage(message: LiveMessage): void {
  if (!RECORD_ENTITIES.has(message.entityType)) return;
  schedule(message.assemblyId);
}

export default defineNitroPlugin((nitroApp) => {
  if (!process.env.DATABASE_URL) return;
  const unsubscribe = subscribeToAll(onMessage);
  nitroApp.hooks.hook("close", () => {
    unsubscribe();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  });
});
