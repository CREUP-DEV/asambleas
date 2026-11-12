/**
 * Whether single-key shortcuts (letters such as "a", "l", "v", "j" with no
 * modifier) act on this browser. WCAG 2.1.4 asks for a way to turn them off:
 * a delegate typing outside a field, or someone using voice control, must
 * never record a decision by accident. Like the other preferences it belongs
 * to the browser, never to the account (one account may be shared).
 *
 * On by default. Every page that defines single-key shortcuts reads
 * `enabled` before acting, and the shortcut help and the preferences offer
 * the same switch.
 */

export const SINGLE_KEY_SHORTCUTS_STORAGE_KEY = "creup:single-key-shortcuts";

function readStored(): string | null {
  try {
    return localStorage.getItem(SINGLE_KEY_SHORTCUTS_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStored(value: boolean): void {
  try {
    localStorage.setItem(
      SINGLE_KEY_SHORTCUTS_STORAGE_KEY,
      value ? "on" : "off",
    );
  } catch {
    // Private mode or blocked storage: the choice lasts for this visit.
  }
}

export const useSingleKeyShortcuts = () => {
  const state = useState<boolean>("single-key-shortcuts", () => true);
  const restored = useState<boolean>(
    "single-key-shortcuts-restored",
    () => false,
  );

  if (import.meta.client && !restored.value) {
    restored.value = true;
    const restore = () => {
      if (readStored() === "off") state.value = false;
    };
    // The server always renders "on". Restoring before hydration would
    // leave the attributes rendered then (aria-keyshortcuts, kbd hints) in
    // place, since hydration does not patch them: restore once it ends,
    // in the same tick as the pages' mounted hooks, before any keystroke.
    const nuxtApp = useNuxtApp();
    if (nuxtApp.isHydrating) {
      nuxtApp.hooks.hookOnce("app:suspense:resolve", restore);
    } else {
      restore();
    }
  }

  const enabled = computed<boolean>({
    get: () => state.value,
    set: (value) => {
      state.value = value;
      if (import.meta.client) writeStored(value);
    },
  });

  return { enabled };
};
