import { describe, expect, it, vi } from "vitest";

// Fetching a picture, and what a failure logs: the database only fails and
// the queue is never reached.
const failure = vi.hoisted(() => ({ error: new Error("unset") }));
vi.mock("../../db", () => ({
  db: {
    select: () => {
      throw failure.error;
    },
  },
}));
vi.mock("../export/queue", () => ({ getExportQueue: vi.fn() }));
const logger = vi.hoisted(() => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("../core/logger", () => logger);

const { AvatarSourceUnavailableError, fetchAvatarSource, refreshUserAvatar } =
  await import("./avatars");

const SOURCE = "https://lh3.googleusercontent.com/a/ACg8oc-photo=s96-c";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

function stub(response: Response | Error) {
  return vi.fn(async (..._args: unknown[]) => {
    if (response instanceof Error) throw response;
    return response;
  });
}

function image(body: BodyInit, headers: Record<string, string> = {}) {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "image/jpeg", ...headers },
  });
}

describe("fetchAvatarSource", () => {
  it("fetches the stored size from Google, never following a redirect", async () => {
    const fetchImpl = stub(image(JPEG));
    const result = await fetchAvatarSource(SOURCE, fetchImpl);
    expect(result).toEqual({ outcome: "ok", data: JPEG });
    const [url, init] = fetchImpl.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://lh3.googleusercontent.com/a/ACg8oc-photo=s192-c");
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // Nothing of the platform travels to Google.
    expect(init.headers).toEqual({ Accept: "image/*" });
  });

  it("never fetches a source off Google's photo host", async () => {
    const fetchImpl = stub(image(JPEG));
    for (const source of [
      "http://lh3.googleusercontent.com/a/x",
      "https://169.254.169.254/latest/meta-data",
      "https://intranet/api",
    ]) {
      expect(await fetchAvatarSource(source, fetchImpl)).toEqual({
        outcome: "unusable",
        reason: "refused",
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("gives up on a redirect, a 4xx or something that is not an image", async () => {
    expect(
      await fetchAvatarSource(
        SOURCE,
        stub(
          new Response(null, {
            status: 302,
            headers: { location: "http://127.0.0.1/" },
          }),
        ),
      ),
    ).toEqual({ outcome: "unusable", reason: "redirect", status: 302 });
    expect(
      await fetchAvatarSource(SOURCE, stub(new Response("", { status: 404 }))),
    ).toEqual({ outcome: "unusable", reason: "status", status: 404 });
    expect(
      await fetchAvatarSource(
        SOURCE,
        stub(image("<html>", { "content-type": "text/html" })),
      ),
    ).toEqual({ outcome: "unusable", reason: "not_image", status: 200 });
  });

  it("stops reading past the size cap", async () => {
    expect(
      await fetchAvatarSource(
        SOURCE,
        stub(image(JPEG, { "content-length": String(6 * 1024 * 1024) })),
      ),
    ).toEqual({ outcome: "unusable", reason: "too_large" });
  });

  it("throws what a retry may mend", async () => {
    for (const response of [
      new Response("", { status: 503 }),
      new Response("", { status: 429 }),
      new TypeError("fetch failed"),
    ]) {
      await expect(
        fetchAvatarSource(SOURCE, stub(response)),
      ).rejects.toBeInstanceOf(AvatarSourceUnavailableError);
    }
  });
});

describe("a failure while refreshing a photo", () => {
  it("is logged by name and SQLSTATE, never with the query's parameters", async () => {
    // What drizzle throws: the query and its parameters in the message.
    class DrizzleQueryError extends Error {}
    failure.error = new DrizzleQueryError(
      `Failed query: insert into "user_avatars" params: u1,${SOURCE}`,
      { cause: Object.assign(new Error("deadlock"), { code: "40P01" }) },
    );
    await expect(refreshUserAvatar("u1")).resolves.toBeUndefined();
    expect(logger.logError).toHaveBeenCalledWith(
      "auth.avatars",
      { name: "DrizzleQueryError", pgCode: "40P01" },
      { action: "refresh", userId: "u1" },
    );
    expect(JSON.stringify(logger.logError.mock.calls)).not.toContain(
      "googleusercontent",
    );
  });
});
