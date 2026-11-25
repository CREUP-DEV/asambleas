<script lang="ts">
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import { scrollParentOf } from "~/utils/scrollAnchor";
import { createPdfCache, type LoadedPdf, type PdfLease } from "./-pdfCache";

/** Reads a PDF and the size of every page, asked of the worker side by side. */
async function openPdf(url: string): Promise<LoadedPdf<PDFDocumentProxy>> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const document = await pdfjs.getDocument({ url, isEvalSupported: false })
    .promise;
  try {
    const pages = await Promise.all(
      Array.from({ length: document.numPages }, (_, index) =>
        document.getPage(index + 1),
      ),
    );
    const sizes = pages.map((page) => {
      const viewport = page.getViewport({ scale: 1 });
      return { width: viewport.width, height: viewport.height };
    });
    return { document, sizes };
  } catch (error) {
    void document.destroy();
    throw error;
  }
}

/**
 * The PDFs this tab keeps loaded (createPdfCache): closing a PDF's window
 * or leaving its page and coming back draws it at once. The last two that
 * nobody shows stay; the file is downloaded again only when it is not one.
 */
const pdfDocuments = createPdfCache<PDFDocumentProxy>({
  open: openPdf,
  close: (document) => void document.destroy(),
  keep: 2,
});
</script>

<script setup lang="ts">
/**
 * A PDF drawn by the platform itself (pdf.js), page after page at the
 * width of its container: the one PDF viewer of the platform (user's
 * decisions of 2026-11-18 and 2026-11-19). It reads the same on a phone, it
 * scrolls with the page (so reaching its end marks it read), and the
 * session can tell where it is scrolled so the projection follows the Mesa
 * page by page, which the browser's own viewer never tells. Each page is a
 * `[data-page]` block (from 1) sized before it is drawn, so positions line
 * up before the pages render. Client only (`.client`).
 *
 * - A page is drawn once it comes near the view and its pixels, with what
 *   pdf.js keeps to draw it (`page.cleanup`), are freed once it is far from
 *   it or the view goes: a drawn page weighs some 18 MB, so a long PDF kept
 *   whole would hold hundreds of megabytes.
 * - With `textLayer` (the default) every page also gets pdf.js's text layer,
 *   transparent over the drawing, so its text can be selected, copied,
 *   found with the browser's search and read by a screen reader, and its
 *   links to the web open in a new tab (other links are left out). The
 *   session and the projection, which only show the pages, leave both out.
 *
 * - The PDF itself, read and with every page's size, stays loaded in the
 *   tab once the component goes (pdfDocuments, the last two nobody shows),
 *   so opening it again draws its pages without downloading it again.
 *
 * Emits `ready` once every page has its size, and again after the width
 * changes, so the caller can scroll to where it should be.
 */
const props = withDefaults(
  defineProps<{
    url: string;
    /** Names the pages for screen readers. */
    title: string;
    /** The text and the links over the pages. */
    textLayer?: boolean;
    /**
     * The link to the file in the line shown when the PDF cannot be drawn.
     * Left out where the page already offers that way (DocumentPdfViewer's
     * «Abrir en una pestaña nueva») or where nobody clicks (the projection).
     */
    fileLink?: boolean;
  }>(),
  { textLayer: true, fileLink: true },
);

const emit = defineEmits<{ ready: []; failed: [] }>();

const { t } = useI18n();

interface PageSize {
  width: number;
  height: number;
}

const root = ref<HTMLElement | null>(null);
const sizes = ref<PageSize[]>([]);
/**
 * The PDF could not be read. Either this or `drawFailed` shows one line,
 * with a link to the file itself (`fileLink`) that the browser opens in its
 * own viewer: the way out where pdf.js cannot run, such as Safari before
 * 17.4 (every browser on an iPhone with iOS 16), which lacks
 * `Promise.withResolvers`.
 */
const failed = ref(false);
const width = ref(0);
/** A page failed to draw (not a drawing let go for another). */
const drawFailed = ref(false);

let pdf: PDFDocumentProxy | null = null;
/** This component's hold on the PDF it shows (pdfDocuments). */
let lease: PdfLease<PDFDocumentProxy> | null = null;
let observer: IntersectionObserver | null = null;
/** Pages drawn, or being drawn, at the current width. */
const drawn = new Set<number>();
/**
 * Pages whose drawing is on show: the others show a skeleton over their
 * box, so a page never reads as a blank sheet while it loads.
 */
const shown = shallowRef<ReadonlySet<number>>(new Set());
function markShown(number: number, value: boolean): void {
  if (shown.value.has(number) === value) return;
  const next = new Set(shown.value);
  if (value) next.add(number);
  else next.delete(number);
  shown.value = next;
}
/** The render under way of each page. */
const renders = new Map<number, RenderTask>();
/**
 * The pages this view has drawn, to free what pdf.js keeps of each
 * (`page.cleanup`) once it is freed: the tab keeps the PDF itself
 * (pdfDocuments), and without it every page once drawn would hold its
 * operator list and its decoded images for as long as the PDF stays.
 */
const pdfPages = new Map<number, PDFPageProxy>();
/** Bumped whenever a page's drawing is started or freed. */
const pageTokens = new Map<number, number>();
let loadToken = 0;

const pageSelector = (number: number) => `[data-page="${number}"]`;
const pageElement = (number: number) =>
  root.value?.querySelector<HTMLElement>(pageSelector(number)) ?? null;

/**
 * Shows the PDF at `url`, leased from the tab's PDFs (pdfDocuments): one
 * already loaded takes its pages' sizes at once, so it opens again with
 * no skeleton and only the pages in view to draw.
 */
function load(url: string): void {
  const token = ++loadToken;
  failed.value = false;
  drawFailed.value = false;
  freeAll();
  shown.value = new Set();
  lease?.release();
  pdf = null;
  const next = pdfDocuments.lease(url);
  lease = next;
  if (next.loaded) {
    show(next.loaded, token);
    return;
  }
  sizes.value = [];
  next.ready.then(
    (loaded) => show(loaded, token),
    () => {
      if (token !== loadToken) return;
      failed.value = true;
      emit("failed");
    },
  );
}

async function show(
  loaded: LoadedPdf<PDFDocumentProxy>,
  token: number,
): Promise<void> {
  if (token !== loadToken) return;
  pdf = loaded.document;
  sizes.value = loaded.sizes;
  await nextTick();
  if (token !== loadToken) return;
  observePages();
  emit("ready");
  if (props.textLayer) void buildLayers(loaded.document, token);
}

function bumpToken(number: number): number {
  const token = (pageTokens.get(number) ?? 0) + 1;
  pageTokens.set(number, token);
  return token;
}

async function draw(number: number): Promise<void> {
  if (!pdf || drawn.has(number) || width.value <= 0) return;
  const document = pdf;
  drawn.add(number);
  const token = bumpToken(number);
  const previous = renders.get(number);
  if (previous) {
    // A canvas takes one render at a time: let the old one go first.
    previous.cancel();
    await previous.promise.catch(() => {});
  }
  try {
    const page = await document.getPage(number);
    const canvas = pageElement(number)?.querySelector("canvas");
    if (!canvas || token !== pageTokens.get(number)) return;
    pdfPages.set(number, page);
    const base = page.getViewport({ scale: 1 });
    const ratio = window.devicePixelRatio || 1;
    const viewport = page.getViewport({
      scale: (width.value * ratio) / base.width,
    });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No 2D context for the page's canvas");
    const task = page.render({ canvasContext: context, viewport });
    renders.set(number, task);
    await task.promise;
    if (renders.get(number) === task) renders.delete(number);
    if (token === pageTokens.get(number)) markShown(number, true);
  } catch (error) {
    if (token !== pageTokens.get(number)) return;
    drawn.delete(number);
    // pdf.js rejects a cancelled render (the page was freed or redrawn):
    // only another error means the page cannot be drawn.
    const cancelled =
      (error as { name?: unknown } | null)?.name ===
      "RenderingCancelledException";
    if (!cancelled) drawFailed.value = true;
  }
}

/**
 * Frees a page's pixels and what pdf.js keeps to draw it (its operator list
 * and images): it is drawn again when it comes back. A render still
 * settling from `cancel` keeps pdf.js from cleaning at once; it cleans a
 * few seconds after it ends, unless the page is drawn again first. Another
 * view of the same PDF shares the page: its drawing stays, and only its
 * next redraw reads the page again.
 */
function free(number: number): void {
  bumpToken(number);
  drawn.delete(number);
  renders.get(number)?.cancel();
  pdfPages.get(number)?.cleanup();
  pdfPages.delete(number);
  const canvas = pageElement(number)?.querySelector("canvas");
  if (canvas && canvas.width > 0) {
    canvas.width = 0;
    canvas.height = 0;
  }
  markShown(number, false);
}

function freeAll(): void {
  for (const number of [...drawn]) free(number);
  for (const task of renders.values()) task.cancel();
  renders.clear();
  // Pages drawn at an old width and not drawn again since.
  for (const page of pdfPages.values()) page.cleanup();
  pdfPages.clear();
}

function observePages(): void {
  observer?.disconnect();
  if (!root.value) return;
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const number = Number((entry.target as HTMLElement).dataset.page);
        if (!(number > 0)) continue;
        if (entry.isIntersecting) void draw(number);
        else free(number);
      }
    },
    // A page and a half ahead, so scrolling never shows a blank page; past
    // that a page is freed. Measured against the box that scrolls (a page
    // panel, the console's column, the projection's box): against the
    // window, a margin never reaches past that box's edge.
    { root: scrollParentOf(root.value), rootMargin: "150% 0px" },
  );
  for (const element of root.value.querySelectorAll("[data-page]")) {
    observer.observe(element);
  }
}

/** Only links to the web or to an address leave the PDF. */
function safeLink(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol)
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

/**
 * The text layer and the links of every page, one page after another, at
 * the page's own scale (`--scale-factor` on the page follows the width, so
 * a resize needs nothing here).
 */
async function buildLayers(
  document: PDFDocumentProxy,
  token: number,
): Promise<void> {
  const { TextLayer } = await import("pdfjs-dist");
  for (let number = 1; number <= document.numPages; number++) {
    if (token !== loadToken) return;
    try {
      const page = await document.getPage(number);
      const element = pageElement(number);
      const textBox = element?.querySelector<HTMLElement>(".textLayer");
      const linkBox = element?.querySelector<HTMLElement>(".pdf-links");
      if (!textBox || !linkBox || token !== loadToken) return;
      const viewport = page.getViewport({ scale: 1 });
      const textLayer = new TextLayer({
        textContentSource: page.streamTextContent(),
        container: textBox,
        viewport,
      });
      await textLayer.render();
      for (const annotation of await page.getAnnotations({
        intent: "display",
      })) {
        if (annotation.subtype !== "Link") continue;
        const href = safeLink(annotation.url);
        if (!href || !Array.isArray(annotation.rect)) continue;
        const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(
          annotation.rect,
        );
        const link = window.document.createElement("a");
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.title = href;
        link.setAttribute("aria-label", href);
        link.style.left = `${(100 * Math.min(x1, x2)) / viewport.width}%`;
        link.style.top = `${(100 * Math.min(y1, y2)) / viewport.height}%`;
        link.style.width = `${(100 * Math.abs(x2 - x1)) / viewport.width}%`;
        link.style.height = `${(100 * Math.abs(y2 - y1)) / viewport.height}%`;
        linkBox.append(link);
      }
    } catch {
      // A page without its text still reads as a drawing.
    }
  }
}

// A new width draws the pages again, sharp, and the caller scrolls back.
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
useResizeObserver(root, (entries) => {
  const next = Math.round(entries[0]?.contentRect.width ?? 0);
  if (next === width.value) return;
  const first = width.value === 0;
  width.value = next;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(
    () => {
      // The pages keep their old drawing until they are drawn again.
      drawn.clear();
      observePages();
      if (sizes.value.length > 0) emit("ready");
    },
    first ? 0 : 150,
  );
});

watch(
  () => props.url,
  (url) => void load(url),
  { immediate: true },
);

onBeforeUnmount(() => {
  loadToken++;
  observer?.disconnect();
  clearTimeout(resizeTimer);
  freeAll();
  // Kept for the next view of it (pdfDocuments), not destroyed.
  lease?.release();
  lease = null;
  pdf = null;
});
</script>

<template>
  <div
    ref="root"
    class="space-y-[clamp(0.5rem,1vw,1rem)]"
    role="document"
    :aria-label="t('workspace.text.pdfFrame', { title })"
  >
    <p
      v-if="failed || drawFailed"
      class="text-muted text-sm"
      data-testid="pdf-pages-failed"
    >
      {{ t("document.pdfPages.failed") }}
      <ULink
        v-if="fileLink"
        :to="url"
        external
        target="_blank"
        class="text-primary font-medium underline underline-offset-4"
      >
        {{ t("document.pdfPages.open") }}
      </ULink>
    </p>
    <div v-if="!failed && sizes.length === 0" class="space-y-3" role="status">
      <span class="sr-only">{{ t("common.loading") }}</span>
      <USkeleton aria-hidden="true" class="aspect-[1/1.414] w-full" />
    </div>
    <div
      v-for="(size, index) in sizes"
      :key="`${url}#${index}`"
      :data-page="index + 1"
      class="pdf-page border-default relative overflow-hidden rounded-md border bg-white shadow-sm"
      :style="{
        aspectRatio: `${size.width} / ${size.height}`,
        '--scale-factor': width / size.width,
      }"
    >
      <canvas class="absolute inset-0 block size-full" aria-hidden="true" />
      <USkeleton
        v-if="!shown.has(index + 1)"
        class="absolute inset-0 rounded-none"
        aria-hidden="true"
      />
      <template v-if="textLayer">
        <div class="textLayer" />
        <div class="pdf-links" />
      </template>
    </div>
  </div>
</template>

<style>
/* The text over a page (pdf.js's TextLayer): transparent, in place, so it
   is selected, found and read where the drawing shows it. From
   pdfjs-dist/web/pdf_viewer.css, only what the text layer itself uses. */
.pdf-page .textLayer {
  position: absolute;
  inset: 0;
  overflow: clip;
  line-height: 1;
  text-align: initial;
  text-size-adjust: none;
  forced-color-adjust: none;
  transform-origin: 0 0;
  caret-color: CanvasText;
  z-index: 1;
}
.pdf-page .textLayer :is(span, br) {
  color: transparent;
  position: absolute;
  white-space: pre;
  cursor: text;
  transform-origin: 0% 0%;
}
.pdf-page .textLayer span.markedContent {
  top: 0;
  height: 0;
}
.pdf-page .textLayer span[role="img"] {
  user-select: none;
  cursor: default;
}
.pdf-page .textLayer ::selection {
  background: color-mix(in srgb, AccentColor, transparent 75%);
}
.pdf-page .textLayer br::selection {
  background: transparent;
}
/* The links, over the text. */
.pdf-page .pdf-links {
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
}
.pdf-page .pdf-links a {
  position: absolute;
  pointer-events: auto;
}
.pdf-page .pdf-links a:hover {
  background: color-mix(in srgb, var(--ui-primary), transparent 85%);
}
.pdf-page .pdf-links a:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 1px;
}
/* What pdf.js measures text with, never shown. */
.hiddenCanvasElement {
  position: absolute;
  top: 0;
  left: 0;
  width: 0;
  height: 0;
  display: none;
}
</style>
