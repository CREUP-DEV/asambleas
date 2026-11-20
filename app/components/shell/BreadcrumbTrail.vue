<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";
import type { Breadcrumb } from "~/composables/shell/useBreadcrumbs";

/**
 * The breadcrumb trail itself, on one line (user's decision of
 * 2026-11-20): its start and its end always show. The first level never
 * shrinks and the last (the page on show) takes at most half the line and
 * shrinks only a little; the
 * levels in between give way first, the longest the most, each cut with an
 * ellipsis (its full label as a tooltip). When even that does not fit, the
 * middle levels fold, from the start, into «…», a menu that opens them.
 * It refits whenever its box changes size or the trail changes.
 */
const props = defineProps<{
  crumbs: Breadcrumb[];
  /** The trail's name for screen readers. */
  label: string;
}>();

const { t } = useI18n();

const list = ref<HTMLElement | null>(null);
/** How many middle levels are folded into «…», from the second one on. */
const folded = ref(0);

type Entry =
  | { type: "crumb"; crumb: Breadcrumb; position: "first" | "middle" | "last" }
  | { type: "folded"; items: DropdownMenuItem[] };

const entries = computed<Entry[]>(() => {
  const crumbs = props.crumbs;
  const last = crumbs.length - 1;
  const position = (index: number): "first" | "middle" | "last" =>
    index === 0 ? "first" : index === last ? "last" : "middle";
  if (folded.value === 0 || crumbs.length <= 2) {
    return crumbs.map((crumb, index) => ({
      type: "crumb",
      crumb,
      position: position(index),
    }));
  }
  const hidden = crumbs.slice(1, 1 + folded.value);
  return [
    { type: "crumb", crumb: crumbs[0]!, position: "first" },
    {
      type: "folded",
      items: hidden.map((crumb) => ({ label: crumb.label, to: crumb.to })),
    },
    ...crumbs.slice(1 + folded.value).map((crumb, offset) => ({
      type: "crumb" as const,
      crumb,
      position: position(1 + folded.value + offset),
    })),
  ];
});

/** The middle levels can fold at most until only the start and end remain. */
const maxFolded = computed(() => Math.max(0, props.crumbs.length - 2));

function overflows(): boolean {
  const box = list.value;
  return box !== null && box.scrollWidth > box.clientWidth + 1;
}

let fitting = false;
/** Unfolds everything, then folds one more level while it overflows. */
async function fit(): Promise<void> {
  if (fitting || !import.meta.client) return;
  fitting = true;
  try {
    folded.value = 0;
    await nextTick();
    while (overflows() && folded.value < maxFolded.value) {
      folded.value += 1;
      await nextTick();
    }
  } finally {
    fitting = false;
  }
}

useResizeObserver(list, () => void fit());
watch(
  () => props.crumbs.map((crumb) => crumb.label).join("\u0000"),
  () => void fit(),
);
onMounted(() => void fit());

/**
 * A short level in the middle («80.ª AGO», «Orden del día») never gives
 * way: only the long ones do, and the short ones fold with the rest.
 */
const SHORT_LABEL = 16;

function shrinkOf(entry: Extract<Entry, { type: "crumb" }>): string {
  if (entry.position === "middle" && entry.crumb.label.length <= SHORT_LABEL) {
    return "shrink-0";
  }
  return SHRINK[entry.position];
}

/** How each level gives way (see above). */
const SHRINK: Record<"first" | "middle" | "last", string> = {
  first: "shrink-0",
  middle: "min-w-[3.5rem] shrink",
  // Never more than half the line: the middle keeps room before folding.
  last: "min-w-[6rem] max-w-[50%] shrink-[0.25]",
};
</script>

<template>
  <nav :aria-label="label" class="flex min-w-0">
    <ol ref="list" class="flex min-w-0 flex-1 items-center gap-1.5">
      <template v-for="(entry, index) in entries" :key="index">
        <li
          v-if="index > 0"
          class="text-dimmed flex shrink-0 items-center"
          aria-hidden="true"
        >
          <UIcon name="i-lucide-chevron-right" class="size-4" />
        </li>
        <li v-if="entry.type === 'folded'" class="flex shrink-0">
          <UDropdownMenu :items="entry.items" :content="{ align: 'start' }">
            <UButton
              color="neutral"
              variant="ghost"
              size="xs"
              icon="i-lucide-ellipsis"
              :aria-label="t('shell.breadcrumb.folded')"
            />
          </UDropdownMenu>
        </li>
        <li v-else class="flex" :class="shrinkOf(entry)">
          <span
            v-if="entry.crumb.current"
            class="text-highlighted truncate text-sm font-semibold"
            :title="entry.crumb.label"
            aria-current="page"
          >
            {{ entry.crumb.label }}
          </span>
          <ULink
            v-else
            :to="entry.crumb.to"
            class="text-muted hover:text-default truncate text-sm font-medium transition-colors"
            :title="entry.crumb.label"
          >
            {{ entry.crumb.label }}
          </ULink>
        </li>
      </template>
    </ol>
  </nav>
</template>
