import type { MaybeRefOrGetter, Ref } from "vue";
import type {
  DocumentEditorPresenceDto,
  DocumentPresenceDto,
} from "~~/shared/types/api";
import { errorStatus, isIdentityChanged, useApi } from "../api/useApi";

/** Heartbeat of an open editor; the server forgets a tab after 90 s. */
export const PRESENCE_HEARTBEAT_MS = 20_000;

/** Statuses after which this tab stops beating: it may not edit any more. */
const FINAL_STATUSES = new Set([401, 403, 404, 409]);

function randomTabId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Who else has this document's draft open in the editor (POST
 * .../presence): this tab announces itself every PRESENCE_HEARTBEAT_MS,
 * right away when it gains or loses unsaved changes or comes back into
 * view, and says goodbye when it closes. Client only; failures stay quiet
 * (the list just keeps its last answer), and a refusal (the text froze, the
 * account may no longer edit it) stops the beat.
 */
export function useDocumentPresence(
  documentApi: MaybeRefOrGetter<string>,
  unsaved: MaybeRefOrGetter<boolean>,
): { editors: Ref<DocumentEditorPresenceDto[]> } {
  const editors = ref<DocumentEditorPresenceDto[]>([]);
  if (import.meta.server) return { editors };

  const { send } = useApi();
  const tabId = randomTabId();
  const url = () => `${toValue(documentApi)}/presence`;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let inflight = false;
  /** A beat asked for while one was running: send it once that one ends. */
  let again = false;

  async function beat(): Promise<void> {
    if (stopped) return;
    if (inflight) {
      again = true;
      return;
    }
    inflight = true;
    try {
      const answer = await send<DocumentPresenceDto>(url(), {
        body: { tabId, unsaved: toValue(unsaved) },
      });
      if (!stopped) editors.value = answer.editors;
    } catch (error) {
      const status = errorStatus(error);
      if (
        isIdentityChanged(error) ||
        (status !== null && FINAL_STATUSES.has(status))
      ) {
        stop();
      }
    } finally {
      inflight = false;
      if (again) {
        again = false;
        void beat();
      }
    }
  }

  function stop(): void {
    stopped = true;
    editors.value = [];
    if (timer) clearInterval(timer);
    timer = null;
  }

  /** Best effort: whatever fails here expires on the server by itself. */
  function leave(): void {
    if (stopped) return;
    send(url(), {
      body: { tabId, leaving: true },
      keepalive: true,
    }).catch(() => undefined);
  }

  function onVisibility(): void {
    if (document.visibilityState === "visible") void beat();
  }

  /** Back from the browser's page cache, after `pagehide` said goodbye. */
  function onPageShow(event: PageTransitionEvent): void {
    if (event.persisted) void beat();
  }

  onMounted(() => {
    void beat();
    timer = setInterval(() => void beat(), PRESENCE_HEARTBEAT_MS);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", onPageShow);
  });

  watch(
    () => toValue(unsaved),
    () => void beat(),
  );

  onBeforeUnmount(() => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", leave);
    window.removeEventListener("pageshow", onPageShow);
    leave();
    stop();
  });

  return { editors };
}
