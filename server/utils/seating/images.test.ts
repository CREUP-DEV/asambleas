import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// processSeatingImageJob with the database, the Intranet and the live
// stream stubbed: what it fetches, writes and names, not how it queries.

const state = vi.hoisted(() => ({
  row: null as {
    version: string | null;
    file: string | null;
    goneAt: Date | null;
  } | null,
  claimed: true,
  sets: [] as Record<string, unknown>[],
  /** Locks taken, in order ("share" for the plan of a claim). */
  locks: [] as string[],
  /** The claim's update ran inside a transaction. */
  inTransaction: false,
}));

vi.mock("../../db", () => {
  const rows = () => (state.row ? [state.row] : []);
  const update = () => ({
    set: (values: Record<string, unknown>) => {
      state.sets.push(values);
      return {
        where: () => ({
          returning: async () => (state.claimed ? [{ id: "row" }] : []),
        }),
      };
    },
  });
  const select = () => ({
    from: () => ({
      where: () =>
        Object.assign(Promise.resolve(rows()), {
          for: async (strength: string) => {
            state.locks.push(strength);
            return [{ id: "plan" }];
          },
        }),
    }),
  });
  return {
    db: {
      select,
      update,
      transaction: async (run: (tx: unknown) => Promise<unknown>) => {
        state.inTransaction = true;
        try {
          return await run({ select, update });
        } finally {
          state.inTransaction = false;
        }
      },
    },
  };
});
vi.mock("../core/logger", () => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
}));
vi.mock("../domain/events", () => ({ notifyLive: vi.fn(async () => {}) }));
vi.mock("./intranet", async (original) => ({
  ...(await original<typeof import("./intranet")>()),
  fetchSeatingImage: vi.fn(),
}));

const { fetchSeatingImage } = await import("./intranet");
const { IntranetUnavailableError } = await import("../members/intranet");
const {
  processSeatingImageJob,
  renderSeatingImage,
  sniffImageFormat,
  stopSeatingImages,
} = await import("./images");
const { SVG_RENDER_LIMITS } = await import("./svgRender");

const PLAN = "p1b2c3d4e5f6g7h8i9j0k1l2";
const PERSON = "a1b2c3d4e5f6g7h8i9j0k1l2";
const job = {
  assemblyId: "cm0assemblyid000000000000",
  planId: PLAN,
  kind: "photo" as const,
  id: PERSON,
  intranetId: 501,
  version: "9f2c",
};
const FILE = `photo-${PERSON}-9f2c.webp`;

const png = (width: number, height: number) =>
  sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 200, g: 30, b: 60, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();

const SVG = Buffer.from(
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"><rect width="300" height="100" fill="#8a1538"/></svg>',
);

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "seating-images-"));
  vi.stubEnv("UPLOAD_STORAGE_DIR", dir);
  state.row = { version: "9f2c", file: null, goneAt: null };
  state.claimed = true;
  state.sets = [];
  state.locks = [];
  vi.mocked(fetchSeatingImage).mockReset();
});

afterEach(async () => {
  stopSeatingImages();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const planFiles = async () =>
  readdir(join(dir, "seating", PLAN)).catch(() => [] as string[]);

describe("sniffImageFormat", () => {
  it("tells the format by its bytes", async () => {
    expect(sniffImageFormat(await png(4, 4))).toBe("png");
    expect(
      sniffImageFormat(
        await sharp(await png(4, 4))
          .jpeg()
          .toBuffer(),
      ),
    ).toBe("jpeg");
    expect(
      sniffImageFormat(
        await sharp(await png(4, 4))
          .webp()
          .toBuffer(),
      ),
    ).toBe("webp");
    expect(sniffImageFormat(Buffer.from("GIF89a......"))).toBe("gif");
    expect(sniffImageFormat(SVG)).toBe("svg");
    expect(sniffImageFormat(Buffer.from('<svg viewBox="0 0 1 1"></svg>'))).toBe(
      "svg",
    );
    expect(sniffImageFormat(Buffer.from("<html><body></body></html>"))).toBe(
      null,
    );
    expect(sniffImageFormat(Buffer.from("BM......"))).toBe(null);
  });
});

describe("renderSeatingImage", () => {
  it("crops a photo to a 192 px square WebP", async () => {
    const out = await renderSeatingImage(await png(400, 300), "photo");
    expect(out).not.toBeNull();
    const meta = await sharp(out!).metadata();
    expect(meta).toMatchObject({ format: "webp", width: 192, height: 192 });
    expect(meta.hasAlpha).toBe(false);
  });

  // An SVG is drawn in a Node process of its own (svgRender.ts): starting
  // one and loading sharp takes seconds when the whole suite runs at once.
  const SLOW = { ...SVG_RENDER_LIMITS, timeoutMs: 60_000 };

  it("fits a logo, an SVG too, on white", { timeout: 90_000 }, async () => {
    const out = await renderSeatingImage(SVG, "logo", SLOW);
    expect(out).not.toBeNull();
    const meta = await sharp(out!).metadata();
    expect(meta).toMatchObject({ format: "webp", width: 192, height: 192 });
    // The top-left corner is the white it was fitted on.
    const { data } = await sharp(out!)
      .extract({ left: 0, top: 0, width: 1, height: 1 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect([...data].slice(0, 3).every((value) => value > 240)).toBe(true);
  });

  it(
    "gives up an SVG it cannot draw in time, killing its process",
    { timeout: 90_000 },
    async () => {
      // A heavy SVG would take minutes; a timeout shorter than the process
      // takes to start stands for it.
      expect(
        await renderSeatingImage(SVG, "logo", { ...SLOW, timeoutMs: 1 }),
      ).toBeNull();
      // The next one is drawn as usual.
      expect(await renderSeatingImage(SVG, "logo", SLOW)).not.toBeNull();
    },
  );

  it("refuses an SVG photo, a format it does not take and broken bytes", async () => {
    expect(await renderSeatingImage(SVG, "photo")).toBeNull();
    expect(
      await renderSeatingImage(Buffer.from("not an image"), "logo"),
    ).toBeNull();
    const broken = (await png(64, 64)).subarray(0, 40);
    expect(await renderSeatingImage(broken, "photo")).toBeNull();
  });
});

describe("processSeatingImageJob", () => {
  it("fetches, draws, writes and names the file", async () => {
    vi.mocked(fetchSeatingImage).mockResolvedValue({
      outcome: "ok",
      data: await png(300, 300),
    });
    expect(await processSeatingImageJob(job)).toBe("cached");
    expect(fetchSeatingImage).toHaveBeenCalledWith("photo", 501);
    expect(await planFiles()).toEqual([FILE]);
    expect(state.sets).toEqual([expect.objectContaining({ photoFile: FILE })]);
    // Named under the plan's lock, as a sync writes the rows under it.
    expect(state.locks).toEqual(["share"]);
  });

  it("skips a row whose version moved on, or that already has the file", async () => {
    state.row = { version: "aaaa", file: null, goneAt: null };
    expect(await processSeatingImageJob(job)).toBe("skipped");
    state.row = { version: "9f2c", file: FILE, goneAt: null };
    expect(await processSeatingImageJob(job)).toBe("skipped");
    state.row = { version: "9f2c", file: null, goneAt: new Date() };
    expect(await processSeatingImageJob(job)).toBe("skipped");
    state.row = null;
    expect(await processSeatingImageJob(job)).toBe("skipped");
    expect(await processSeatingImageJob({ ...job, version: "../x" })).toBe(
      "skipped",
    );
    expect(fetchSeatingImage).not.toHaveBeenCalled();
  });

  it("removes what it wrote when a sync changed the version meanwhile", async () => {
    vi.mocked(fetchSeatingImage).mockResolvedValue({
      outcome: "ok",
      data: await png(300, 300),
    });
    state.claimed = false;
    expect(await processSeatingImageJob(job)).toBe("stale");
    expect(await planFiles()).toEqual([]);
  });

  it("gives up an image the Intranet does not serve or sharp cannot read", async () => {
    vi.mocked(fetchSeatingImage).mockResolvedValue({
      outcome: "missing",
      reason: "not_found",
    });
    expect(await processSeatingImageJob(job)).toBe("missing");
    vi.mocked(fetchSeatingImage).mockResolvedValue({
      outcome: "ok",
      data: Buffer.from("<html></html>"),
    });
    expect(await processSeatingImageJob(job)).toBe("unreadable");
    expect(await planFiles()).toEqual([]);
    expect(state.sets).toEqual([]);
  });

  it("lets the queue retry when the Intranet cannot answer", async () => {
    vi.mocked(fetchSeatingImage).mockRejectedValue(
      new IntranetUnavailableError("asistentes/501/foto", "status 503"),
    );
    await expect(processSeatingImageJob(job)).rejects.toBeInstanceOf(
      IntranetUnavailableError,
    );
  });
});
