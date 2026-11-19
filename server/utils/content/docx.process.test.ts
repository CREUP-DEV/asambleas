// DOCX import: the converter process and its queue. The converter's tests are
// split over docx*.test.ts so that Vitest runs them side by side, since each
// spawns its converter processes one after another; their builders live in
// server/testing/docx.ts.

import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { convertDocx, DOCX_LIMITS } from "./docx";
import {
  nextOwner,
  convert,
  p,
  stored,
  docxWith,
  documentXml,
  TEST_LIMITS,
  attributeNames,
  repeatedElementDocx,
  convertTimed,
} from "../../testing/docx";

/** Converter processes started, and a hook run right after each start. */
const converters = vi.hoisted(() => ({
  started: [] as ChildProcess[],
  onStart: null as (() => void) | null,
}));

// mammoth must only run in the converter process. If this process ever called
// it, every conversion below would fail.
vi.mock("mammoth", () => {
  const forbidden = () => {
    throw new Error("mammoth ran in the server process");
  };
  return { default: { convertToHtml: forbidden, images: {} } };
});

vi.mock("node:child_process", async (importOriginal) => {
  const childProcess =
    await importOriginal<typeof import("node:child_process")>();
  const spawn = childProcess.spawn as (...args: unknown[]) => ChildProcess;
  return {
    ...childProcess,
    spawn: (...args: unknown[]) => {
      const child = spawn(...args);
      converters.started.push(child);
      converters.onStart?.();
      return child;
    },
  };
});

// Every test spawns at least one converter process, about 0.6 s each here.
describe("convertDocx converter process", { timeout: 30_000 }, () => {
  // Each bomb below is a few dozen KB that xmldom, which mammoth parses with,
  // turns into hundreds of MB of DOM. In this process that meant gigabytes and
  // a stalled event loop; the converter process runs out of heap instead.

  it("refuses valueless attributes (`<w:p a b c/>`) past the converter heap", async () => {
    const data = repeatedElementDocx(
      `<w:p ${attributeNames(200).join(" ")}/>`,
      5_000,
    );
    expect(data.length).toBeLessThan(64 * 1024);
    const { error, longestStall } = await convertTimed(data, TEST_LIMITS);
    expect(error).toMatchObject({ statusCode: 413 });
    expect(longestStall).toBeLessThan(2_000);
  });

  it('refuses quote-attached attributes (`a"x"b"y"`) past the converter heap', async () => {
    const data = repeatedElementDocx(
      `<w:p ${attributeNames(200)
        .map((name) => `${name}"x"`)
        .join("")}/>`,
      5_000,
    );
    expect(data.length).toBeLessThan(64 * 1024);
    const { error, longestStall } = await convertTimed(data, TEST_LIMITS);
    expect(error).toMatchObject({ statusCode: 413 });
    expect(longestStall).toBeLessThan(2_000);
  });

  it("refuses more elements than the converter heap holds", async () => {
    const data = repeatedElementDocx("<w:p/>", 1_000_000);
    expect(data.length).toBeLessThan(64 * 1024);
    await expect(convert(data, TEST_LIMITS)).rejects.toMatchObject({
      statusCode: 413,
    });
  });

  it("reports malformed markup that fits in the heap as an invalid file", async () => {
    const data = repeatedElementDocx(
      `<w:p ${attributeNames(3).join(" ")}/>`,
      1,
    );
    await expect(convert(data, TEST_LIMITS)).rejects.toMatchObject({
      statusCode: 415,
    });
  });

  it("stops a conversion that outlasts the timeout", async () => {
    const data = docxWith(
      stored("word/document.xml", documentXml(p(null, "Texto"))),
    );
    await expect(
      convert(data, { ...DOCX_LIMITS, converterTimeoutMs: 1 }),
    ).rejects.toMatchObject({ statusCode: 413 });
  });

  it("refuses more HTML than the limits allow", async () => {
    const data = docxWith(
      stored(
        "word/document.xml",
        documentXml(
          ["Uno", "Dos", "Tres", "Cuatro"]
            .map((text) => p(null, text))
            .join(""),
        ),
      ),
    );
    await expect(
      convert(data, { ...DOCX_LIMITS, maxHtmlBytes: 16 }),
    ).rejects.toMatchObject({ statusCode: 413 });
    await expect(
      convert(data, { ...DOCX_LIMITS, maxHtmlNodes: 6 }),
    ).rejects.toMatchObject({ statusCode: 413 });
    const result = await convert(data, { ...DOCX_LIMITS, maxHtmlNodes: 8 });
    expect(result.blocks.map((block) => block.text)).toEqual([
      "Uno",
      "Dos",
      "Tres",
      "Cuatro",
    ]);
  });

  it("ignores a style map embedded in the file", async () => {
    const data = docxWith(
      stored("word/document.xml", documentXml(p(null, "Texto"))),
      [stored("mammoth/style-map", "p => h1:fresh")],
    );
    const result = await convert(data);
    expect(result.blocks.map((block) => block.type)).toEqual(["paragraph"]);
  });
});

const isRefused = (outcome: PromiseSettledResult<unknown>, status: number) =>
  outcome.status === "rejected" &&
  (outcome.reason as { statusCode?: number }).statusCode === status;

describe("convertDocx queue", { timeout: 30_000 }, () => {
  const data = docxWith(
    stored("word/document.xml", documentXml(p(null, "Texto"))),
  );

  it("queues concurrent imports and answers 429 when the queue is full", async () => {
    const users = Array.from({ length: 8 }, nextOwner);
    // One running and six waiting; the eighth is refused before any await.
    const outcomes = await Promise.allSettled(
      users.map((owner) => convertDocx(data, { owner })),
    );
    expect(outcomes.filter((outcome) => isRefused(outcome, 429))).toHaveLength(
      1,
    );
    expect(isRefused(outcomes[7]!, 429)).toBe(true);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(7);
    // Refusing the eighth did not count it as running.
    await expect(convertDocx(data, { owner: users[7]! })).resolves.toEqual(
      expect.objectContaining({ blocks: [expect.anything()] }),
    );
  });

  it("allows each user one import running or waiting", async () => {
    const owner = nextOwner();
    const [first, second] = await Promise.allSettled([
      convertDocx(data, { owner }),
      convertDocx(data, { owner }),
    ]);
    expect(first!.status).toBe("fulfilled");
    expect(isRefused(second!, 429)).toBe(true);
    // Once the first is done, the same user may import again, even after a
    // conversion that failed.
    await expect(
      convertDocx(docxWith(stored("word/document.xml", "")), { owner }),
    ).rejects.toMatchObject({ statusCode: 415 });
    await expect(convertDocx(data, { owner })).resolves.toEqual(
      expect.objectContaining({ blocks: [expect.anything()] }),
    );
  });

  it("does not let one user hold the queue", async () => {
    const owner = nextOwner();
    const outcomes = await Promise.allSettled([
      ...Array.from({ length: 7 }, () => convertDocx(data, { owner })),
      convertDocx(data, { owner: nextOwner() }),
    ]);
    expect(outcomes.filter((outcome) => isRefused(outcome, 429))).toHaveLength(
      6,
    );
    expect(outcomes[0]!.status).toBe("fulfilled");
    expect(outcomes[7]!.status).toBe("fulfilled");
  });

  it("lets a user whose queued import was cancelled import again at once", async () => {
    const before = converters.started.length;
    const owner = nextOwner();
    const cancel = new AbortController();
    const running = convertDocx(data, { owner: nextOwner() });
    const queued = convertDocx(data, { owner, signal: cancel.signal });
    cancel.abort();
    // Still behind the running import: queued again, not refused.
    const again = convertDocx(data, { owner });
    const [cancelled, first, second] = await Promise.allSettled([
      queued,
      running,
      again,
    ]);
    expect(isRefused(cancelled!, 499)).toBe(true);
    expect(first!.status).toBe("fulfilled");
    expect(second!.status).toBe("fulfilled");
    expect(converters.started.length - before).toBe(2);
  });

  it("refuses an import whose client is already gone without queueing it", async () => {
    const owner = nextOwner();
    await expect(
      convertDocx(data, { owner, signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ statusCode: 499 });
    await expect(convertDocx(data, { owner })).resolves.toBeDefined();
  });

  it("skips a queued import whose client went away", async () => {
    const before = converters.started.length;
    const cancel = new AbortController();
    const running = convertDocx(data, { owner: nextOwner() });
    const queued = convertDocx(data, {
      owner: nextOwner(),
      signal: cancel.signal,
    });
    cancel.abort();
    await expect(queued).rejects.toMatchObject({ statusCode: 499 });
    await expect(running).resolves.toBeDefined();
    expect(converters.started.length - before).toBe(1);
    // The slot it held was passed on.
    await expect(convert(data)).resolves.toBeDefined();
  });

  it("stops a running import whose client went away", async () => {
    const cancel = new AbortController();
    converters.onStart = () => setImmediate(() => cancel.abort());
    try {
      await expect(
        convertDocx(data, { owner: nextOwner(), signal: cancel.signal }),
      ).rejects.toMatchObject({ statusCode: 499 });
    } finally {
      converters.onStart = null;
    }
    expect(converters.started.at(-1)!.killed).toBe(true);
    await expect(convert(data)).resolves.toBeDefined();
  });
});
