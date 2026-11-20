import { authClient } from "~/composables/security/useAuth";
import {
  randomWait,
  readSessionKeepaliveAt,
  SESSION_KEEPALIVE_CHECK_MS,
  SESSION_KEEPALIVE_JITTER_MS,
  SESSION_KEEPALIVE_ONLINE_JITTER_MS,
  SESSION_KEEPALIVE_READY_JITTER_MS,
  SESSION_KEEPALIVE_STORAGE_KEY,
  SESSION_KEEPALIVE_VISIBLE_JITTER_MS,
  sessionKeepaliveDue,
  writeSessionKeepaliveAt,
} from "~/composables/security/-sessionKeepalive";

/**
 * Keeps the session alive and its cookie cache warm while the app is shown
 * (./../composables/security/-sessionKeepalive.ts says why both). The app's
 * own endpoints never refresh the session (requireAuth), so only
 * better-auth's GET /api/auth/get-session, asked from the browser, extends
 * the session row and the cookie together (once a day at most, `updateAge`)
 * and sends a fresh `session_data` cookie. It asks, skipping the cache, a
 * little after the app is ready, when a hidden page is shown again, when the
 * network comes back and on a timer; never while the page is hidden, and
 * about every 3.5-4 minutes per browser at most (every tab shares the time).
 *
 * The answer is ignored: identity comes only from GET /api/me (useMe), since
 * better-auth's session stays the signed-in Admin's while they act as
 * another account.
 */
export default defineNuxtPlugin(() => {
  let storage: Storage | null = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }
  let lastAt: number | null = null;
  let asking = false;
  // This device's share of the jitter before its next ask.
  let jitter = randomWait(SESSION_KEEPALIVE_JITTER_MS);

  const ask = () => {
    if (asking || document.visibilityState === "hidden") return;
    const stored = readSessionKeepaliveAt(storage);
    const previous =
      stored === null
        ? lastAt
        : lastAt === null
          ? stored
          : Math.max(stored, lastAt);
    const now = Date.now();
    if (!sessionKeepaliveDue(previous, now, jitter)) return;

    asking = true;
    lastAt = now;
    jitter = randomWait(SESSION_KEEPALIVE_JITTER_MS);
    writeSessionKeepaliveAt(storage, now);
    const retrySooner = () => {
      // A failed ask (network, 429, 5xx) does not count: the next check asks again.
      lastAt = previous;
      if (previous === null) {
        try {
          storage?.removeItem(SESSION_KEEPALIVE_STORAGE_KEY);
        } catch {
          // Ignored, as in writeSessionKeepaliveAt.
        }
      } else {
        writeSessionKeepaliveAt(storage, previous);
      }
    };
    authClient
      .getSession({ query: { disableCookieCache: true } })
      .then((result) => {
        if (result.error) retrySooner();
      })
      .catch(retrySooner)
      .finally(() => {
        asking = false;
      });
  };

  const askAfter = (max: number) => {
    setTimeout(ask, randomWait(max));
  };

  onNuxtReady(() => askAfter(SESSION_KEEPALIVE_READY_JITTER_MS));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      askAfter(SESSION_KEEPALIVE_VISIBLE_JITTER_MS);
    }
  });
  window.addEventListener("online", () => {
    askAfter(SESSION_KEEPALIVE_ONLINE_JITTER_MS);
  });
  setInterval(ask, SESSION_KEEPALIVE_CHECK_MS);
});
