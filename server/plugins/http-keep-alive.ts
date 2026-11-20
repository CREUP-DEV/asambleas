import { Server } from "node:http";

/**
 * Idle time a kept-alive connection from nginx survives in Node: above the
 * 60 s `keepalive_timeout` an nginx upstream with `keepalive` would use, so
 * nginx always closes an idle connection first. With Node's default (5 s),
 * nginx could send a request on a socket Node has just closed and answer 502,
 * which the vhost turns into the maintenance page.
 */
export const KEEP_ALIVE_TIMEOUT_MS = 65_000;

/** Above `KEEP_ALIVE_TIMEOUT_MS`, as Node asks, and below `requestTimeout` (300 s). */
export const HEADERS_TIMEOUT_MS = 66_000;

/**
 * Raises the keep-alive and headers timeouts of the HTTP server a request
 * arrived on, never lowering them. Node reads both on the server each time
 * (when a response finishes, and in its periodic check), so setting them after
 * `listen` works. Returns whether `server` was a Node HTTP server.
 */
export function raiseKeepAliveTimeouts(server: unknown): boolean {
  if (!(server instanceof Server)) return false;
  if (server.keepAliveTimeout < KEEP_ALIVE_TIMEOUT_MS) {
    server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  }
  if (server.headersTimeout < HEADERS_TIMEOUT_MS) {
    server.headersTimeout = HEADERS_TIMEOUT_MS;
  }
  return true;
}

/**
 * Nitro's node-server entry creates the HTTP server after the plugins run and
 * hands it to none of them, so this reaches it through the first request's
 * socket (Node sets `socket.server` on every connection it accepts) and then
 * unhooks. It only matters when nginx keeps connections to the app open,
 * which the tracked vhost does not do (its `proxy_pass` uses a variable).
 */
export default defineNitroPlugin((nitroApp) => {
  const unhook = nitroApp.hooks.hook("request", (event) => {
    const socket = event.node.req.socket as unknown as
      { server?: unknown } | undefined;
    if (raiseKeepAliveTimeouts(socket?.server)) unhook();
  });
});
