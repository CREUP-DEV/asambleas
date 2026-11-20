import { Server } from "node:http";
import { afterAll, describe, expect, it, vi } from "vitest";

// The plugin file calls Nitro's auto-imported `defineNitroPlugin` when it
// loads; outside Nitro it only has to hand the plugin function back.
vi.stubGlobal("defineNitroPlugin", (plugin: unknown) => plugin);

const {
  default: plugin,
  HEADERS_TIMEOUT_MS,
  KEEP_ALIVE_TIMEOUT_MS,
  raiseKeepAliveTimeouts,
} = await import("./http-keep-alive");

afterAll(() => {
  vi.unstubAllGlobals();
});

type RequestHook = (event: unknown) => void;

function fakeNitroApp() {
  const hooks: RequestHook[] = [];
  const unhook = vi.fn(() => {
    hooks.length = 0;
  });
  const hook = vi.fn((name: string, fn: RequestHook) => {
    expect(name).toBe("request");
    hooks.push(fn);
    return unhook;
  });
  return { app: { hooks: { hook } }, hooks, unhook };
}

function requestOn(server: unknown) {
  return { node: { req: { socket: { server } } } };
}

describe("raiseKeepAliveTimeouts", () => {
  it("raises Node's defaults above nginx's upstream keepalive_timeout", () => {
    const server = new Server();
    expect(server.keepAliveTimeout).toBeLessThan(KEEP_ALIVE_TIMEOUT_MS);

    expect(raiseKeepAliveTimeouts(server)).toBe(true);

    expect(server.keepAliveTimeout).toBe(65_000);
    expect(server.headersTimeout).toBe(66_000);
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
    expect(server.headersTimeout).toBeLessThanOrEqual(server.requestTimeout);
  });

  it("never lowers a longer timeout", () => {
    const server = new Server();
    server.keepAliveTimeout = 120_000;
    server.headersTimeout = 121_000;

    expect(raiseKeepAliveTimeouts(server)).toBe(true);

    expect(server.keepAliveTimeout).toBe(120_000);
    expect(server.headersTimeout).toBe(121_000);
  });

  it("leaves anything that is not a Node HTTP server alone", () => {
    const lookalike = { keepAliveTimeout: 5_000, headersTimeout: 60_000 };

    expect(raiseKeepAliveTimeouts(undefined)).toBe(false);
    expect(raiseKeepAliveTimeouts(null)).toBe(false);
    expect(raiseKeepAliveTimeouts(lookalike)).toBe(false);
    expect(lookalike).toEqual({
      keepAliveTimeout: 5_000,
      headersTimeout: 60_000,
    });
  });
});

describe("http-keep-alive plugin", () => {
  it("tunes the server of the first request and unhooks", () => {
    const { app, hooks, unhook } = fakeNitroApp();
    (plugin as (app: unknown) => void)(app);
    expect(hooks).toHaveLength(1);

    const server = new Server();
    hooks[0]!(requestOn(server));

    expect(server.keepAliveTimeout).toBe(KEEP_ALIVE_TIMEOUT_MS);
    expect(server.headersTimeout).toBe(HEADERS_TIMEOUT_MS);
    expect(unhook).toHaveBeenCalledTimes(1);
  });

  it("keeps listening while requests carry no server", () => {
    const { app, hooks, unhook } = fakeNitroApp();
    (plugin as (app: unknown) => void)(app);

    hooks[0]!({ node: { req: {} } });
    hooks[0]!(requestOn(undefined));
    expect(unhook).not.toHaveBeenCalled();

    hooks[0]!(requestOn(new Server()));
    expect(unhook).toHaveBeenCalledTimes(1);
  });
});
