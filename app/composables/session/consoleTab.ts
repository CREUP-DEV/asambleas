/**
 * The browser tab of the session console open on this page, if any: useApi
 * names it on every write (CONSOLE_TAB_HEADER_NAME), so the server knows
 * which console holds control of the projection (useProjectionControl).
 * Set while the console is mounted, cleared when it leaves; a page without
 * a console sends no tab and never moves the projection.
 */
let current: string | null = null;

export function currentConsoleTab(): string | null {
  return current;
}

export function setConsoleTab(tabId: string | null): void {
  current = tabId;
}

const STORAGE_KEY = "creup-session-console-tab";
const CHANNEL = "creup-session-console-tab";
/** How long a new page waits for another tab to claim the same id. */
const CLAIM_WAIT_MS = 150;

function randomTabId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function readStored(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function store(id: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Without storage the tab id lasts until the page reloads.
  }
}

let channel: BroadcastChannel | null = null;

/** Answers a new tab that asks whether its id is already in use here. */
function listen(id: () => string | null): void {
  if (channel || typeof BroadcastChannel === "undefined") return;
  channel = new BroadcastChannel(CHANNEL);
  channel.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { type?: string; id?: string } | null;
    if (data?.type === "hello" && data.id && data.id === id()) {
      channel?.postMessage({ type: "taken", id: data.id });
    }
  });
}

/**
 * This tab's id, kept in sessionStorage so a reload keeps it (and with it
 * control of the projection). A tab the browser duplicated copies that
 * storage too: it asks the other tabs first, and makes a new id when one
 * answers that it already uses it. Client only.
 */
export async function resolveConsoleTabId(): Promise<string> {
  let id = readStored() ?? randomTabId();
  if (typeof BroadcastChannel !== "undefined") {
    const probe = new BroadcastChannel(CHANNEL);
    const taken = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), CLAIM_WAIT_MS);
      probe.addEventListener("message", (event: MessageEvent) => {
        const data = event.data as { type?: string; id?: string } | null;
        if (data?.type === "taken" && data.id === id) {
          clearTimeout(timer);
          resolve(true);
        }
      });
      probe.postMessage({ type: "hello", id });
    });
    probe.close();
    if (taken) id = randomTabId();
  }
  store(id);
  listen(() => readStored());
  return id;
}
