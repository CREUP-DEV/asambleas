import { createError } from "h3";
import { afterAll, describe, expect, it, vi } from "vitest";

// The plugin file calls Nitro's auto-imported `defineNitroPlugin` when it
// loads; outside Nitro it only has to hand the plugin function back.
vi.stubGlobal("defineNitroPlugin", (plugin: unknown) => plugin);
vi.mock("../utils/core/logger", () => ({ logError: vi.fn() }));

const { default: plugin } = await import("./error-funnel");

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("error-funnel plugin", () => {
  it("funnels an unhandled API error before the app's own onError", async () => {
    const seen: unknown[] = [];
    const onError = vi.fn(
      (error: { statusCode: number; message: string }, _event?: unknown) => {
        seen.push({ statusCode: error.statusCode, message: error.message });
      },
    );
    const nitroApp = { h3App: { options: { onError } } };
    (plugin as (app: unknown) => void)(nitroApp);

    const error = createError(
      Object.assign(new Error("valores secretos"), { code: "23505" }),
    );
    error.unhandled = true;
    await nitroApp.h3App.options.onError(error, {
      path: "/api/me/preferences",
    } as never);

    expect(onError).toHaveBeenCalledOnce();
    expect(seen).toEqual([
      { statusCode: 409, message: "Ya existe un registro con esos datos" },
    ]);
  });
});
