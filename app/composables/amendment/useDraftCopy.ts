import type { WatchSource } from "vue";
import {
  draftCopyKey,
  dropDraftCopy,
  isDraftCopyRename,
  pruneDraftCopies,
  readDraftCopy,
  writeDraftCopy,
  type DraftCopyComposer,
  type DraftCopyEntry,
  type DraftCopyPlace,
  type DraftCopyStamp,
  type DraftCopyStorage,
} from "./draftCopy";

/** Expired copies are pruned once per page load. */
let pruned = false;

function browserStorage(): DraftCopyStorage | null {
  if (!import.meta.client) return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export interface UseDraftCopyOptions<T> {
  composer: DraftCopyComposer;
  /** The document the copy belongs to; null keeps nothing. */
  documentId: () => string | null;
  /** The stored draft's id, or what a new one is. */
  scope: () => string;
  stamp: () => DraftCopyStamp;
  /**
   * What to keep now, or null when nothing would be lost (nothing typed,
   * saved, sent, discarded). Cheap and with no side effects: it runs on
   * every change.
   */
  snapshot: () => T | null;
  /** What changes the snapshot: each change writes it a moment later. */
  track: WatchSource[];
  /**
   * Brings in what is still pending (the editor's last keystrokes) before
   * the copy is written as the tab goes to the background.
   */
  settle?: () => void;
  /** Whether a stored copy still fits what the composer has now. */
  accept: (data: unknown) => data is T;
  /**
   * Whether the composer knows enough to read and write its copy (its base
   * and its amendments are loaded). While it does not, nothing is read,
   * written or removed: a copy is never judged, or taken for nothing to keep,
   * against data still loading. Always ready when left out.
   */
  ready?: () => boolean;
  /**
   * Whether a change of scope is the same work under a new name (a new
   * amendment that got its id once saved): the copy under the old key goes.
   * Any other change of key keeps the old copy (`isDraftCopyRename`).
   */
  renamed?: (from: string, to: string) => boolean;
}

/**
 * Keeps a composer's unsaved work in this browser (`draftCopy.ts`) and
 * offers it back once when the composer opens again.
 *
 * - Each change writes the copy a moment later, and at once when the tab goes
 *   to the background (`visibilitychange`, `pagehide`): a phone discards a
 *   hidden tab without `beforeunload`.
 * - With nothing to lose the copy is removed, so sending, saving or
 *   discarding leaves nothing behind.
 * - `open()` reads the copy (on mount, or when a panel opens). While it is
 *   offered nothing overwrites it; the author's first real change takes the
 *   offer away and the copy becomes what they write now.
 * - `discard()` removes it for good when the work is given up (sent,
 *   «Salir sin guardar», a confirmed cancel or leave): no later write brings
 *   it back until `resume()` (a composer that stays mounted and starts a new
 *   draft). `dismiss()` is the offer's «Descartar»: the old copy goes and
 *   new writing is kept as usual.
 * - A change of key (another document, the account signing out or its
 *   session expiring) leaves the old copy where it is: an unanswered offer is
 *   offered again until it is answered, expires or is overwritten. Only a
 *   rename the composer declares (`renamed`: a new amendment that got its id)
 *   moves it.
 * - Until `ready`, nothing is read, written or removed.
 */
export function useDraftCopy<T>(options: UseDraftCopyOptions<T>) {
  const { me } = useMe();
  const offer = shallowRef<DraftCopyEntry<T> | null>(null);
  /** Set by discard(), cleared only by resume(). */
  let halted = false;
  /** The composer is gone: a write still pending is dropped. */
  let disposed = false;

  /**
   * The key of the copy that holds this composer's own work (it wrote or
   * recovered it), while it is there: only that one follows a rename.
   */
  let ownKey: string | null = null;

  const place = computed<DraftCopyPlace | null>(() => {
    const userId = me.value?.id;
    const documentId = options.documentId();
    if (!userId || !documentId) return null;
    return {
      composer: options.composer,
      userId,
      documentId,
      scope: options.scope(),
    };
  });
  const key = computed(() => (place.value ? draftCopyKey(place.value) : null));

  /** The key the offer was read from. */
  let offerKey: string | null = null;

  // An offer belongs to its key: on another key it goes from the screen,
  // stays stored, and is offered again the next time `open()` reads it.
  // (A composer may open the new key's copy before this runs: that offer
  // stays.)
  watch(key, (next) => {
    if (offer.value && offerKey !== next) offer.value = null;
  });

  // A new draft that got its id: the copy this composer wrote under the old
  // key would never be read again. Any other change keeps it (an unanswered
  // offer on another document, the account signing out or expiring).
  watch(place, (next, previous) => {
    if (!isDraftCopyRename(previous, next, options.renamed)) return;
    const old = draftCopyKey(previous!);
    if (old !== ownKey) return;
    dropDraftCopy(browserStorage(), old);
    ownKey = null;
  });

  function ready(): boolean {
    return options.ready?.() ?? true;
  }

  function write(): void {
    if (halted || disposed || !ready()) return;
    const target = key.value;
    if (!target) return;
    const data = options.snapshot();
    if (offer.value) {
      // Nothing changed yet: the offered copy stays as it is.
      if (data === null) return;
      offer.value = null;
    }
    const storage = browserStorage();
    if (data === null) {
      dropDraftCopy(storage, target);
      if (ownKey === target) ownKey = null;
    } else if (
      writeDraftCopy(storage, target, data, options.stamp(), Date.now())
    ) {
      ownKey = target;
    }
  }

  const scheduled = useDebounceFn(write, 800);
  watch(options.track, () => {
    void scheduled();
  });

  /** Writes at once, the editor's pending keystrokes included. */
  function flush(): void {
    if (halted || !key.value) return;
    try {
      options.settle?.();
    } catch {
      // A composer half torn down: keep what the last write kept.
    }
    write();
  }

  if (import.meta.client) {
    useEventListener(document, "visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
    useEventListener(window, "pagehide", flush);
  }

  // Closed without anyone discarding it (the parent closed it): keep what
  // it holds, as a reload would. The component's scope stops before its
  // children unmount, so the editor is still there to hand over its last
  // keystrokes (`settle`).
  onScopeDispose(() => {
    flush();
    disposed = true;
  });

  /** Reads the copy to offer, if one still fits (only once `ready`). */
  function open(): void {
    if (!ready()) return;
    const storage = browserStorage();
    if (!storage) return;
    if (!pruned) {
      pruned = true;
      pruneDraftCopies(storage, Date.now());
    }
    const target = key.value;
    if (!target) return;
    const entry = readDraftCopy(storage, target, options.stamp(), Date.now());
    if (!entry) {
      offer.value = null;
      return;
    }
    if (options.accept(entry.data)) {
      offerKey = target;
      offer.value = entry as DraftCopyEntry<T>;
    } else {
      offer.value = null;
      dropDraftCopy(storage, target);
    }
  }

  /** The offered work, for the composer to put back; the offer goes. */
  function recover(): T | null {
    const data = offer.value?.data ?? null;
    offer.value = null;
    // What it holds is this composer's work now, as if it had written it.
    if (data !== null) ownKey = key.value;
    return data;
  }

  /**
   * The work is given up (sent, created, «Salir sin guardar», a confirmed
   * cancel or leave): the copy goes and nothing is written again until
   * `resume()`, so neither a write still pending nor the composer's own
   * changes while it closes bring it back.
   */
  function discard(): void {
    halted = true;
    offer.value = null;
    drop();
  }

  /** A composer that stays mounted starts a new draft: keep it again. */
  function resume(): void {
    halted = false;
  }

  /**
   * «Descartar» on the offer: the old copy goes, and what the author writes
   * from now on is kept as usual.
   */
  function dismiss(): void {
    offer.value = null;
    drop();
  }

  /** Removes the copy under the current key. */
  function drop(): void {
    const target = key.value;
    if (!target) return;
    dropDraftCopy(browserStorage(), target);
    if (ownKey === target) ownKey = null;
  }

  return { offer, open, recover, discard, resume, dismiss, flush };
}
