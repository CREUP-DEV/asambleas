import type { NuxtApp } from "#app";
import type { LiveEventDto, MeNoticesDto } from "~~/shared/types/api";
import { isNewNotice, newestNoticeAt } from "~~/shared/utils/notices";
import {
  createNoticeRefresher,
  laterNoticeMark,
  withNoticeMark,
  type NoticeRefresher,
} from "./-notices";

const DATA_KEY = "shell-notices";
const OPEN_KEY = "shell-notices-open";
const PANEL_SEEN_KEY = "shell-notices-panel-seen-at";
const FAILED_KEY = "shell-notices-failed";
const PANEL_READY_KEY = "shell-notices-panel-ready";
const MARK_WRITTEN_KEY = "shell-notices-mark-written";
const MARK_WRITING_KEY = "shell-notices-mark-writing";

/** One schedule of reads per app (createNoticeRefresher), client only. */
const refreshers = new WeakMap<NuxtApp, NoticeRefresher>();

/**
 * The account's notices («Avisos», GET /api/me/notices), shared by the
 * sidebar's entry, the phone's menu button (ShellNavbarToggle) and the
 * panel (ShellNotices).
 *
 * Read on the client only, after the page is mounted: the server renders
 * no count, and the first client render has none either, so the count
 * never breaks hydration, and a page render never pays loadWorkNews. Read
 * again when the route changes and when the tab is shown again (ShellNotices
 * asks), and inside an assembly on the live events about a document the
 * notices come from, or about any for the Mesa (`followLive`, from the
 * hub), at most every 30 s
 * (createNoticeRefresher). No timer polls it.
 *
 * Opening the panel marks the notices seen up to the newest one it shows
 * (PUT /api/me/notices/seen), and so does each read that lands while it
 * stays open, except while an Admin acts as the account: the account did
 * not see them, and the server writes nothing either.
 */
export function useNotices() {
  const nuxtApp = useNuxtApp();
  const api = useApi();
  const { impersonation } = useMe();
  const data = useState<MeNoticesDto | null>(DATA_KEY, () => null);
  const open = useState<boolean>(OPEN_KEY, () => false);
  /**
   * The account's mark when the panel opened: the panel splits «Nuevos»
   * from «Anteriores» by it while it stays open.
   */
  const panelSeenAt = useState<string | null>(PANEL_SEEN_KEY, () => null);

  /**
   * The open panel has taken its mark (panelSeenAt) from a list: from then
   * on each read that lands marks what it brings as seen, still under
   * «Nuevos». False while the panel opens and once it closes.
   */
  const panelReady = useState<boolean>(PANEL_READY_KEY, () => false);
  /**
   * The marks this tab wrote (confirmed) and is writing (in flight). The
   * server's mark never goes back, so a read that answers with an older
   * one left before the write landed: it keeps the later (withNoticeMark).
   * A failed write is dropped, and the next read brings the count back.
   */
  const markWritten = useState<string | null>(MARK_WRITTEN_KEY, () => null);
  const markWriting = useState<string | null>(MARK_WRITING_KEY, () => null);

  /** The last read failed (the last list read, if any, stays). */
  const failed = useState<boolean>(FAILED_KEY, () => false);

  /** How many notices are new; null until the first read. */
  const unread = computed<number | null>(() => data.value?.unread ?? null);

  async function read(): Promise<void> {
    try {
      const fresh = await $fetch<MeNoticesDto>("/api/me/notices");
      data.value = withNoticeMark(
        fresh,
        laterNoticeMark(markWritten.value, markWriting.value),
      );
      failed.value = false;
    } catch (error) {
      failed.value = true;
      throw error;
    }
    // A notice that arrives while the panel is open is in front of the
    // user, under «Nuevos»: it is seen, and no count is left behind.
    if (open.value && panelReady.value) void markSeen();
  }

  function refresher(): NoticeRefresher | null {
    if (!import.meta.client) return null;
    let current = refreshers.get(nuxtApp);
    if (!current) {
      current = createNoticeRefresher({
        run: read,
        hasData: () => data.value !== null,
        watch: () => ({
          documentIds: data.value?.watchDocumentIds ?? [],
          // Absent from a list read before the Mesa's notices.
          assemblyIds: data.value?.watchAssemblyIds ?? [],
        }),
      });
      refreshers.set(nuxtApp, current);
    }
    return current;
  }

  /** A route change or the tab shown again (throttled). */
  function refreshThrottled(): void {
    void refresher()?.request();
  }

  /**
   * A batch of the hub's live events, of the assembly `assemblyId`
   * (filtered, throttled).
   */
  function followLive(
    events: readonly LiveEventDto[],
    assemblyId: string | null = null,
  ): void {
    refresher()?.live(events, assemblyId);
  }

  /**
   * Marks the notices seen up to the newest one listed (noticeMoment),
   * never the clock: one that arrived after the read stays new. Nothing
   * while an Admin acts as the account. A failed write is left to the next
   * read.
   */
  async function markSeen(): Promise<void> {
    const current = data.value;
    if (!current || impersonation.value) return;
    const at = newestNoticeAt(current.items);
    if (at === null || !isNewNotice(at, current.seenAt)) return;
    data.value = withNoticeMark(current, at);
    markWriting.value = laterNoticeMark(markWriting.value, at);
    try {
      await api.send("/api/me/notices/seen", { method: "PUT", body: { at } });
      markWritten.value = laterNoticeMark(markWritten.value, at);
    } catch {
      // The count comes back with the next read; nothing to tell.
    } finally {
      if (markWriting.value === at) markWriting.value = null;
    }
  }

  /**
   * Opens the panel: splits its lists by the account's current mark at
   * once, waits for a read when there is none yet, the last one is older
   * than the interval or one is on its way, takes the mark again from that
   * read (another tab may have moved it) for the panel's «Nuevos», then
   * marks them seen. Closed before the read lands, it marks nothing.
   */
  async function openPanel(): Promise<void> {
    panelReady.value = false;
    panelSeenAt.value = data.value?.seenAt ?? null;
    open.value = true;
    await refresher()?.request();
    if (!open.value) return;
    panelSeenAt.value = data.value?.seenAt ?? null;
    panelReady.value = data.value !== null;
    await markSeen();
  }

  function closePanel(): void {
    open.value = false;
    panelReady.value = false;
  }

  /** Reads the notices again now (the panel's «Reintentar»). */
  async function retry(): Promise<void> {
    // A panel that has its mark already marks what the read brings (read).
    const ready = panelReady.value;
    await refresher()?.force();
    if (ready || !open.value || data.value === null) return;
    panelSeenAt.value = data.value.seenAt;
    panelReady.value = true;
    await markSeen();
  }

  /** Drops a read waiting for the end of its interval (the layout leaves). */
  function dispose(): void {
    if (!import.meta.client) return;
    refreshers.get(nuxtApp)?.dispose();
  }

  return {
    data: computed(() => data.value),
    failed: readonly(failed),
    unread,
    open,
    panelSeenAt: readonly(panelSeenAt),
    refreshThrottled,
    followLive,
    openPanel,
    closePanel,
    retry,
    dispose,
  };
}
