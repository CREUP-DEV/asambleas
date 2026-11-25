/**
 * The PDFs a tab has loaded, kept between the components that draw them
 * (DocumentPdfPages): closing Directo's document window, or any other view
 * of a PDF, and opening it again draws the pages at once instead of
 * downloading and reading the whole file again.
 *
 * A PDF's url names one file for good (a new upload gets a new stored name),
 * so a PDF kept under its url never goes stale. Each component leases the
 * PDF it shows and gives it back when it unmounts or shows another; the
 * last `keep` PDFs nobody shows stay loaded, the oldest beyond that is
 * closed. One that could not be loaded is forgotten, so the next lease
 * tries again.
 */

/** A page's size at scale 1, in PDF points. */
export interface PdfPageSize {
  width: number;
  height: number;
}

/** A PDF read and ready to draw: the document and the size of every page. */
export interface LoadedPdf<D> {
  document: D;
  sizes: PdfPageSize[];
}

/** A component's hold on a PDF, until it calls `release`. */
export interface PdfLease<D> {
  /** The PDF, already loaded when the lease starts; null while it loads. */
  loaded: LoadedPdf<D> | null;
  /** Settles once the PDF is loaded (at once when `loaded`). */
  ready: Promise<LoadedPdf<D>>;
  /** Gives it back; more than once is the same as once. */
  release: () => void;
}

export interface PdfCacheOptions<D> {
  /** Reads a PDF from its url. */
  open: (url: string) => Promise<LoadedPdf<D>>;
  /**
   * Frees a PDF for good (pdf.js `destroy`). Never the document's pdf.js
   * `cleanup` on one nobody shows: it clears state a quick reopen may
   * already be drawing with, and a kept PDF weighs only its parsed file (the
   * component frees each page it drew, pixels and pdf.js's `page.cleanup`,
   * before it gives the PDF back).
   */
  close: (document: D) => void;
  /** How many PDFs nobody shows stay loaded. */
  keep: number;
}

export interface PdfCache<D> {
  lease: (url: string) => PdfLease<D>;
  /** The urls held, loaded or loading (tests). */
  urls: () => string[];
}

interface Entry<D> {
  url: string;
  ready: Promise<LoadedPdf<D>>;
  loaded: LoadedPdf<D> | null;
  users: number;
  /** Closed (evicted or failed): never handed out again. */
  gone: boolean;
}

export function createPdfCache<D>(options: PdfCacheOptions<D>): PdfCache<D> {
  const entries = new Map<string, Entry<D>>();
  /** Urls nobody shows, the oldest first. */
  const unused: string[] = [];

  function forget(entry: Entry<D>): void {
    entry.gone = true;
    if (entries.get(entry.url) === entry) entries.delete(entry.url);
    const index = unused.indexOf(entry.url);
    if (index >= 0) unused.splice(index, 1);
  }

  function evict(entry: Entry<D>): void {
    forget(entry);
    if (entry.loaded) {
      options.close(entry.loaded.document);
      return;
    }
    // One still loading is closed once it arrives.
    entry.ready.then(
      (loaded) => options.close(loaded.document),
      () => {},
    );
  }

  function trim(): void {
    while (unused.length > options.keep) {
      const entry = entries.get(unused[0]!);
      if (entry) evict(entry);
      else unused.shift();
    }
  }

  function entryFor(url: string): Entry<D> {
    const held = entries.get(url);
    if (held) return held;
    const entry: Entry<D> = {
      url,
      ready: options.open(url),
      loaded: null,
      users: 0,
      gone: false,
    };
    entries.set(url, entry);
    entry.ready.then(
      (loaded) => {
        entry.loaded = loaded;
      },
      () => {
        // Not kept: the next lease tries again.
        forget(entry);
      },
    );
    return entry;
  }

  return {
    lease(url) {
      const entry = entryFor(url);
      entry.users++;
      const index = unused.indexOf(url);
      if (index >= 0) unused.splice(index, 1);
      let released = false;
      return {
        loaded: entry.loaded,
        ready: entry.ready,
        release() {
          if (released) return;
          released = true;
          entry.users--;
          if (entry.users > 0 || entry.gone) return;
          unused.push(url);
          trim();
        },
      };
    },
    urls: () => [...entries.keys()],
  };
}
