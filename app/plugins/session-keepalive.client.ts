import { authClient } from "~/composables/security/useAuth";
import {
  readSessionKeepaliveAt,
  SESSION_KEEPALIVE_ONLINE_JITTER_MS,
  SESSION_KEEPALIVE_STORAGE_KEY,
  sessionKeepaliveDue,
  writeSessionKeepaliveAt,
} from "~/composables/security/-sessionKeepalive";

/** How often a visible page checks whether the keepalive is due (no request unless it is). */
const CHECK_EVERY_MS = 5 * 60_000;

/**
 * Keeps the session cookie alive while the app is used. The app's own
 * endpoints never refresh the session (requireAuth), so only better-auth's
 * GET /api/auth/get-session, asked from the browser, extends the session
 * row and the cookie together (once a day at most, `updateAge`). It asks
 * once the app is ready, when a hidden page is shown again, when the
 * network comes back and, for pages left open all day such as the
 * projection, on a timer; never more than once an hour per browser
 * (./-sessionKeepalive.ts).
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
    if (!sessionKeepaliveDue(previous, now)) return;

    asking = true;
    lastAt = now;
    writeSessionKeepaliveAt(storage, now);
    const retrySooner = () => {
      // A failed ask (network, 5xx) does not count: the next trigger asks again.
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
      .getSession()
      .then((result) => {
        if (result.error) retrySooner();
      })
      .catch(retrySooner)
      .finally(() => {
        asking = false;
      });
  };

  onNuxtReady(ask);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") ask();
  });
  window.addEventListener("online", () => {
    setTimeout(ask, Math.random() * SESSION_KEEPALIVE_ONLINE_JITTER_MS);
  });
  setInterval(ask, CHECK_EVERY_MS);
});
