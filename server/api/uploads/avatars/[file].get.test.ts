import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { H3Event } from "h3";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createError } from "h3";

// GET /api/uploads/avatars/[file] with the actor and the photo's row
// stubbed and a real upload directory: who may read a photo and which
// files it serves.

const USER = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const NAME = `${USER}-0123456789abcdef.webp`;
const OLD = `${USER}-fedcba9876543210.webp`;

const state = vi.hoisted(() => ({
  rows: [] as { file: string | null }[],
  name: undefined as string | undefined,
}));
const requireActor = vi.hoisted(() => vi.fn());
const sendStream = vi.hoisted(() => vi.fn(() => "streamed"));
const setResponseHeaders = vi.hoisted(() => vi.fn());

vi.mock("h3", async (importOriginal) => ({
  ...(await importOriginal<typeof import("h3")>()),
  getRouterParam: () => state.name,
  sendStream,
  setResponseHeaders,
}));
vi.mock("../../../utils/domain/actor", () => ({ requireActor }));
vi.mock("../../../db", () => {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => state.rows,
  };
  return { db: { select: () => chain } };
});

const { default: handler } = await import("./[file].get");
// sendReadStream listens for the response's close to destroy the stream.
const event = {
  node: { res: { once: () => undefined } },
} as unknown as H3Event;

let uploads: string;

beforeAll(async () => {
  uploads = await mkdtemp(join(tmpdir(), "avatars-route-"));
  vi.stubEnv("UPLOAD_STORAGE_DIR", uploads);
  await mkdir(join(uploads, "avatars"), { recursive: true });
  await writeFile(join(uploads, "avatars", NAME), "webp");
  await writeFile(join(uploads, "avatars", OLD), "webp");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(uploads, { recursive: true, force: true });
});

beforeEach(() => {
  requireActor.mockReset();
  requireActor.mockResolvedValue({ user: { id: "someone" } });
  sendStream.mockClear();
  setResponseHeaders.mockClear();
  state.rows = [{ file: NAME }];
  state.name = NAME;
});

async function status(): Promise<number | undefined> {
  try {
    await handler(event);
  } catch (error) {
    return (error as { statusCode?: number }).statusCode;
  }
  return 200;
}

describe("GET /api/uploads/avatars/[file]", () => {
  it("serves the photo its row names to a signed-in account, cached for good", async () => {
    await expect(handler(event)).resolves.toBe("streamed");
    expect(setResponseHeaders).toHaveBeenCalledWith(event, {
      "Content-Type": "image/webp",
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    });
  });

  it("serves nothing to a request without an account with access", async () => {
    requireActor.mockRejectedValue(createError({ statusCode: 401 }));
    expect(await status()).toBe(401);
    expect(sendStream).not.toHaveBeenCalled();
  });

  it("answers 404 for a photo no row names now", async () => {
    state.name = OLD;
    expect(await status()).toBe(404);
    state.rows = [];
    state.name = NAME;
    expect(await status()).toBe(404);
    state.rows = [{ file: null }];
    expect(await status()).toBe(404);
    expect(sendStream).not.toHaveBeenCalled();
  });

  it("answers 404 for a name that is not a photo's", async () => {
    for (const name of [
      undefined,
      "../documents/x.pdf",
      `${USER}-0123456789abcdef.png`,
      "lh3.googleusercontent.com",
    ]) {
      state.name = name;
      state.rows = [{ file: name ?? null }];
      expect(await status()).toBe(404);
    }
  });

  it("answers 404 when the row names a file that is not on disk", async () => {
    const missing = `${USER}-aaaaaaaaaaaaaaaa.webp`;
    state.name = missing;
    state.rows = [{ file: missing }];
    expect(await status()).toBe(404);
  });
});
