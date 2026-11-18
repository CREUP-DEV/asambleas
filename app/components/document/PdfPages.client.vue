<script setup lang="ts">
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy } from "pdfjs-dist";

/**
 * A PDF drawn by the platform itself (pdf.js), page after page at the
 * width of its container, so the session can tell where it is scrolled and
 * the projection can follow the Mesa page by page (user's decision of
 * 2026-11-18). The browser's own viewer cannot: a page never learns where
 * it is scrolled. The container scrolls; each page is a `[data-page]`
 * block (from 1) sized before it is drawn, so positions line up before the
 * pages render, and a page is drawn once it comes near the view. No text
 * layer: it is read, not selected. Client only (`.client`).
 *
 * Emits `ready` once every page has its size, and again after the width
 * changes, so the caller can scroll to where it should be.
 */
const props = defineProps<{
  url: string;
  /** Names the pages for screen readers. */
  title: string;
}>();

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
/** Pages drawn at the current width. */
const drawn = new Set<number>();
let loadToken = 0;

async function load(url: string): Promise<void> {
  const token = ++loadToken;
  failed.value = false;
  sizes.value = [];
  drawn.clear();
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
  } catch {
    if (token !== loadToken) return;
    failed.value = true;
    emit("failed");
  }
}

async function draw(number: number): Promise<void> {
  if (!pdf || drawn.has(number) || !root.value) return;
  const canvas = root.value.querySelector<HTMLCanvasElement>(
    `[data-page="${number}"] canvas`,
  );
  if (!canvas || width.value <= 0) return;
  drawn.add(number);
  try {
    const page = await pdf.getPage(number);
    const base = page.getViewport({ scale: 1 });
    const ratio = window.devicePixelRatio || 1;
    const viewport = page.getViewport({
      scale: (width.value * ratio) / base.width,
    });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const context = canvas.getContext("2d");
    if (!context) return;
    await page.render({ canvasContext: context, viewport }).promise;
  } catch {
    drawn.delete(number);
  }
}

function observePages(): void {
  observer?.disconnect();
  if (!root.value) return;
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const number = Number((entry.target as HTMLElement).dataset.page);
        if (number > 0) void draw(number);
      }
    },
    // A page and a half ahead, so scrolling never shows a blank page.
    { rootMargin: "150% 0px" },
  );
  for (const element of root.value.querySelectorAll("[data-page]")) {
    observer.observe(element);
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
      :key="index"
      :data-page="index + 1"
      class="border-default overflow-hidden rounded-md border bg-white shadow-sm"
      :style="{ aspectRatio: `${size.width} / ${size.height}` }"
    >
      <canvas class="block h-full w-full" aria-hidden="true" />
    </div>
  </div>
</template>
