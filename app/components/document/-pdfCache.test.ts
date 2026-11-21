import { describe, expect, it, vi } from "vitest";
import { createPdfCache, type LoadedPdf } from "./-pdfCache";

interface FakePdf {
  url: string;
}

function setup(keep = 1) {
  const pending = new Map<
    string,
    {
      resolve: (value: LoadedPdf<FakePdf>) => void;
      reject: (error: Error) => void;
    }
  >();
  const open = vi.fn(
    (url: string) =>
      new Promise<LoadedPdf<FakePdf>>((resolve, reject) => {
        pending.set(url, { resolve, reject });
      }),
  );
  const close = vi.fn<(document: FakePdf) => void>();
  const cache = createPdfCache<FakePdf>({ open, close, keep });
  const arrive = async (url: string) => {
    pending.get(url)!.resolve({
      document: { url },
      sizes: [{ width: 595, height: 842 }],
    });
    await Promise.resolve();
    await Promise.resolve();
  };
  const fail = async (url: string) => {
    pending.get(url)!.reject(new Error("network"));
    await Promise.resolve();
    await Promise.resolve();
  };
  return { cache, open, close, arrive, fail };
}

describe("createPdfCache (the PDFs a tab keeps loaded)", () => {
  it("hands a PDF opened again over at once, without reading it again", async () => {
    const { cache, open, arrive } = setup();
    const first = cache.lease("/a.pdf");
    expect(first.loaded).toBeNull();
    await arrive("/a.pdf");
    await expect(first.ready).resolves.toMatchObject({
      document: { url: "/a.pdf" },
    });
    first.release();

    const again = cache.lease("/a.pdf");
    expect(again.loaded?.document).toEqual({ url: "/a.pdf" });
    expect(again.loaded?.sizes).toEqual([{ width: 595, height: 842 }]);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("shares one read between two views of the same PDF", async () => {
    const { cache, open, close, arrive } = setup(0);
    const one = cache.lease("/a.pdf");
    const two = cache.lease("/a.pdf");
    expect(open).toHaveBeenCalledTimes(1);
    await arrive("/a.pdf");
    one.release();
    // Still shown by the other one.
    expect(close).not.toHaveBeenCalled();
    two.release();
    expect(close).toHaveBeenCalledWith({ url: "/a.pdf" });
  });

  it("keeps the last `keep` PDFs nobody shows and closes the oldest", async () => {
    const { cache, close, arrive } = setup(1);
    const a = cache.lease("/a.pdf");
    await arrive("/a.pdf");
    a.release();
    expect(close).not.toHaveBeenCalled();

    const b = cache.lease("/b.pdf");
    await arrive("/b.pdf");
    b.release();
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith({ url: "/a.pdf" });
    expect(cache.urls()).toEqual(["/b.pdf"]);
  });

  it("counts a PDF shown again as the newest", async () => {
    const { cache, close, arrive } = setup(2);
    for (const url of ["/a.pdf", "/b.pdf"]) {
      const lease = cache.lease(url);
      await arrive(url);
      lease.release();
    }
    cache.lease("/a.pdf").release();
    const c = cache.lease("/c.pdf");
    await arrive("/c.pdf");
    c.release();
    expect(close).toHaveBeenCalledWith({ url: "/b.pdf" });
    expect(cache.urls().sort()).toEqual(["/a.pdf", "/c.pdf"]);
  });

  it("closes one evicted while it loads once it arrives", async () => {
    const { cache, close, arrive } = setup(0);
    cache.lease("/a.pdf").release();
    expect(cache.urls()).toEqual([]);
    expect(close).not.toHaveBeenCalled();
    await arrive("/a.pdf");
    expect(close).toHaveBeenCalledWith({ url: "/a.pdf" });
  });

  it("forgets a PDF that could not be loaded, so the next lease reads it again", async () => {
    const { cache, open, close, fail } = setup();
    const lease = cache.lease("/a.pdf");
    await fail("/a.pdf");
    await expect(lease.ready).rejects.toThrow("network");
    lease.release();
    expect(cache.urls()).toEqual([]);
    expect(close).not.toHaveBeenCalled();

    cache.lease("/a.pdf");
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("takes a second release of the same lease as the first", async () => {
    const { cache, close, arrive } = setup(0);
    const one = cache.lease("/a.pdf");
    const two = cache.lease("/a.pdf");
    await arrive("/a.pdf");
    one.release();
    one.release();
    expect(close).not.toHaveBeenCalled();
    two.release();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
