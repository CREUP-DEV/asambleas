<script setup lang="ts">
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";

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
 * - A page is drawn once it comes near the view and its pixels are freed
 *   once it is far from it: a drawn page weighs some 18 MB, so a long PDF
 *   kept whole would hold hundreds of megabytes.
 * - With `textLayer` (the default) every page also gets pdf.js's text layer,
 *   transparent over the drawing, so its text can be selected, copied,
 *   found with the browser's search and read by a screen reader, and its
 *   links to the web open in a new tab (other links are left out). The
 *   session and the projection, which only show the pages, leave both out.
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
  }>(),
  { textLayer: true },
);

const emit = defineEmits<{ ready: []; failed: [] }>();

const { t } = useI18n();

interface PageSize {
  width: number;
  height: number;
}

const root = ref<HTMLElement | null>(null);
const sizes = ref<PageSize[]>([]);
const failed = ref(false);
const width = ref(0);

let pdf: PDFDocumentProxy | null = null;
let observer: IntersectionObserver | null = null;
/** Pages drawn, or being drawn, at the current width. */
const drawn = new Set<number>();
/** The render under way of each page. */
const renders = new Map<number, RenderTask>();
/** Bumped whenever a page's drawing is started or freed. */
const pageTokens = new Map<number, number>();
let loadToken = 0;

const pageSelector = (number: number) => `[data-page="${number}"]`;
const pageElement = (number: number) =>
  root.value?.querySelector<HTMLElement>(pageSelector(number)) ?? null;

async function load(url: string): Promise<void> {
  const token = ++loadToken;
  failed.value = false;
  freeAll();
  sizes.value = [];
  try {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    const next = await pdfjs.getDocument({ url, isEvalSupported: false })
      .promise;
    if (token !== loadToken) {
      void next.destroy();
      return;
    }
    void pdf?.destroy();
    pdf = next;
    const pageSizes: PageSize[] = [];
    for (let number = 1; number <= next.numPages; number++) {
      const page = await next.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      pageSizes.push({ width: viewport.width, height: viewport.height });
    }
    if (token !== loadToken) return;
    sizes.value = pageSizes;
    await nextTick();
    observePages();
    emit("ready");
    if (props.textLayer) void buildLayers(next, token);
  } catch {
    if (token !== loadToken) return;
    failed.value = true;
    emit("failed");
  }
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
    const base = page.getViewport({ scale: 1 });
    const ratio = window.devicePixelRatio || 1;
    const viewport = page.getViewport({
      scale: (width.value * ratio) / base.width,
    });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const context = canvas.getContext("2d");
    if (!context) return;
    const task = page.render({ canvasContext: context, viewport });
    renders.set(number, task);
    await task.promise;
    if (renders.get(number) === task) renders.delete(number);
  } catch {
    if (token === pageTokens.get(number)) drawn.delete(number);
  }
}

/** Frees a page's pixels: it is drawn again when it comes back. */
function free(number: number): void {
  bumpToken(number);
  drawn.delete(number);
  renders.get(number)?.cancel();
  const canvas = pageElement(number)?.querySelector("canvas");
  if (canvas && canvas.width > 0) {
    canvas.width = 0;
    canvas.height = 0;
  }
}

function freeAll(): void {
  for (const number of [...drawn]) free(number);
  for (const task of renders.values()) task.cancel();
  renders.clear();
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
    // that a page is freed.
    { rootMargin: "150% 0px" },
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
  void pdf?.destroy();
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
    <p v-if="failed" class="text-muted text-sm">
      {{ t("document.pdfPages.failed") }}
    </p>
    <div v-else-if="sizes.length === 0" class="space-y-3" role="status">
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
