<script setup lang="ts">
import type { LivePoint } from "~~/shared/types/api";
import type { PointerState } from "~/composables/session/pointerState";
import { pointIn } from "~/utils/scrollAnchor";
import { rangeOfSpan } from "~/utils/textSpan";

/**
 * Draws the Mesa's pointer over a document (its own preview and the
 * projection): a red dot with a glow, ripples where it clicks and the
 * strokes it draws, fading once done unless pinned. It sits over the
 * document's content (`scope`, positioned) and scrolls with it; every point
 * is placed on the block or page it belongs to (pointIn), so it lands on
 * the same place whatever the screen. Never takes the pointer: it is a
 * picture. Hidden from screen readers.
 */
const props = withDefaults(
  defineProps<{
    state: PointerState;
    /** The document's content the points are measured on. */
    scope: HTMLElement | null;
    /**
     * Highlights the words the Mesa selected (`::highlight(cx-mesa-select)`
     * in main.css, over the text as it is: never written into it). Off on
     * the Mesa's own screen, which shows its selection itself.
     */
    showSelection?: boolean;
  }>(),
  { showSelection: true },
);

const layer = ref<SVGSVGElement | null>(null);
/** Bumped when the content changes size, so every point is placed again. */
const version = ref(0);
useResizeObserver(
  () => props.scope,
  () => {
    version.value++;
  },
);
// Pages and blocks lay out after the content mounts (a PDF draws later).
onMounted(() => {
  requestAnimationFrame(() => version.value++);
});

const width = ref(0);
function place(point: LivePoint): { x: number; y: number } | null {
  void version.value;
  const svg = layer.value;
  const scope = props.scope;
  if (!svg || !scope) return null;
  return pointIn(svg, scope, point);
}

watch(
  version,
  () => {
    width.value = layer.value?.getBoundingClientRect().width ?? 0;
  },
  { flush: "post" },
);
/** The thickness of a stroke, wider on a wide screen. */
const strokeWidth = computed(() => Math.max(3, width.value * 0.004));

const pointer = computed(() =>
  props.state.pointer ? place(props.state.pointer) : null,
);

const strokes = computed(() =>
  props.state.strokes.map((stroke) => {
    const points = stroke.points
      .map(place)
      .filter((point): point is { x: number; y: number } => point !== null);
    const d =
      points.length === 1
        ? `M${points[0]!.x} ${points[0]!.y}l0.01 0`
        : points
            .map(
              (point, index) =>
                `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`,
            )
            .join("");
    return {
      id: stroke.id,
      d,
      fading: stroke.endedAt !== null && !stroke.pinned,
    };
  }),
);

const ripples = computed(() =>
  props.state.ripples
    .map((ripple) => ({ id: ripple.id, at: place(ripple.point) }))
    .filter((ripple) => ripple.at !== null),
);

const radius = computed(() => Math.max(10, width.value * 0.012));

// The Mesa's selection, highlighted on the same words.
const HIGHLIGHT = "cx-mesa-select";
function highlights(): Map<string, unknown> | null {
  const registry = (globalThis.CSS as { highlights?: Map<string, unknown> })
    ?.highlights;
  return registry && typeof globalThis.Highlight === "function"
    ? registry
    : null;
}
watch(
  () => [props.state.selection, props.scope, version.value] as const,
  ([span, scope]) => {
    const registry = highlights();
    if (!registry || !props.showSelection) return;
    const range = span && scope ? rangeOfSpan(scope, span) : null;
    if (range) registry.set(HIGHLIGHT, new Highlight(range));
    else registry.delete(HIGHLIGHT);
  },
  { flush: "post" },
);
onBeforeUnmount(() => {
  if (props.showSelection) highlights()?.delete(HIGHLIGHT);
});
</script>

<template>
  <svg
    ref="layer"
    class="pointer-layer pointer-events-none absolute inset-0 z-10 h-full w-full overflow-visible"
    aria-hidden="true"
  >
    <path
      v-for="stroke in strokes"
      :key="stroke.id"
      :d="stroke.d"
      class="pointer-stroke"
      :class="{ 'pointer-stroke-fading': stroke.fading }"
      fill="none"
      :stroke-width="strokeWidth"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <g
      v-for="ripple in ripples"
      :key="ripple.id"
      :transform="`translate(${ripple.at!.x} ${ripple.at!.y})`"
    >
      <circle
        v-for="ring in 3"
        :key="ring"
        class="pointer-ripple"
        :style="{ animationDelay: `${(ring - 1) * 0.16}s` }"
        :r="radius * 4"
        fill="none"
        :stroke-width="Math.max(2, strokeWidth * 0.8)"
      />
    </g>
    <g v-if="pointer" :transform="`translate(${pointer.x} ${pointer.y})`">
      <circle class="pointer-glow" :r="radius * 1.8" />
      <circle class="pointer-dot" :r="radius * 0.55" />
    </g>
  </svg>
</template>

<style scoped>
.pointer-stroke {
  stroke: color-mix(in oklab, var(--ui-color-error-500) 75%, transparent);
}

.pointer-stroke-fading {
  animation: pointer-fade 4.5s ease-in forwards;
}

.pointer-ripple {
  stroke: var(--ui-primary);
  transform-box: fill-box;
  transform-origin: center;
  opacity: 0;
  animation: pointer-ripple 0.9s ease-out forwards;
}

.pointer-glow {
  fill: color-mix(in oklab, var(--ui-color-error-500) 25%, transparent);
}

.pointer-dot {
  fill: var(--ui-color-error-500);
  stroke: white;
  stroke-width: 2px;
}

@keyframes pointer-fade {
  0%,
  45% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}

@keyframes pointer-ripple {
  0% {
    transform: scale(0.1);
    opacity: 0.9;
  }
  100% {
    transform: scale(1);
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .pointer-ripple {
    animation: pointer-ripple-still 0.9s linear forwards;
    transform: scale(0.35);
  }

  @keyframes pointer-ripple-still {
    0% {
      opacity: 0.9;
    }
    100% {
      opacity: 0;
    }
  }
}
</style>
