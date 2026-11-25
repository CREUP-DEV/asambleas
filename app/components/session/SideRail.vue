<script setup lang="ts">
import { revealIn } from "./-reveal";

/**
 * The console's side column (speakers, headcounts, agenda, final text)
 * folded into a strip of icons along the right edge, so the debate takes
 * the width (user's decision of 2026-11-19). Resting the mouse on it opens
 * it over the debate, sliding in, and it folds again a moment after the
 * mouse leaves. It stays open while something opened from it is open (a
 * menu, a popover, a dialog) and while the keyboard is inside it; Escape
 * folds it and gives the focus back to the strip. «Fijar» keeps it open
 * beside the debate, remembered per browser, from xl only: below, 26rem
 * beside the debate would leave it a strip of text (E-132). An icon of the
 * strip opens it at its section, unfolded, by mouse, touch or keyboard; the
 * agenda's opens at the item in debate.
 *
 * Folded, the strip keeps in view what the Mesa watches all along: under
 * each icon what its section counts (`count`, the turns waiting), a dot of
 * colour (`dot`, whether there is quorum) and the `strip` slot (the turn's
 * clock).
 *
 * The sections stay mounted while folded (their forms and lists survive);
 * folded they are inert, out of the tab order.
 */
export interface SideRailItem {
  /** The SessionFoldPanel's id: the strip scrolls to `session-fold-<id>`. */
  id: string;
  icon: string;
  title: string;
  summary?: string | null;
  /** A number under the icon (e.g. the turns waiting); none when 0. */
  count?: number | null;
  /** The background class of a dot on the icon (e.g. `bg-success`). */
  dot?: string | null;
}

defineProps<{ items: SideRailItem[] }>();
defineSlots<{
  default?: () => unknown;
  strip?: (props: { item: SideRailItem }) => unknown;
}>();

const { t } = useI18n();

const pinned = useLocalStorage("session-side-pinned", false);
/** Pinning is offered from xl; a pin kept from a wider screen waits. */
const wide = useMediaQuery("(min-width: 1280px)");
const pinnedHere = computed(() => pinned.value && wide.value);
const hovered = ref(false);
/** Opened from the strip (a click, a tap or the keyboard). */
const opened = ref(false);
const expanded = computed(
  () => pinnedHere.value || hovered.value || opened.value,
);
/** The section last opened from the strip: Escape gives its icon the focus. */
const lastOpened = ref<string | null>(null);

const aside = ref<HTMLElement | null>(null);
const strip = ref<HTMLElement | null>(null);
const body = ref<HTMLElement | null>(null);
const scroller = ref<HTMLElement | null>(null);

let openTimer: ReturnType<typeof setTimeout> | undefined;
let closeTimer: ReturnType<typeof setTimeout> | undefined;

/** Something opened from the side column, or the keyboard, is still in it. */
function held(): boolean {
  const element = aside.value;
  if (!element) return false;
  if (element.querySelector('[aria-haspopup][aria-expanded="true"]')) {
    return true;
  }
  if (
    window.document.querySelector('[role="dialog"][data-state="open"]') ||
    window.document.querySelector('[role="alertdialog"][data-state="open"]')
  ) {
    return true;
  }
  return element.matches(":has(:focus-visible)");
}

function onEnter(): void {
  clearTimeout(closeTimer);
  clearTimeout(openTimer);
  // A short pause, so crossing the strip on the way elsewhere opens nothing.
  openTimer = setTimeout(() => {
    hovered.value = true;
  }, 120);
}

function scheduleClose(): void {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    if (held()) {
      scheduleClose();
      return;
    }
    hovered.value = false;
    opened.value = false;
  }, 350);
}

function onLeave(): void {
  clearTimeout(openTimer);
  scheduleClose();
}

/** The keyboard leaves the column: it folds, unless the mouse is on it. */
function onFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget as Node | null;
  if (next && aside.value?.contains(next)) return;
  if (!hovered.value) scheduleClose();
}

/**
 * Opens the column at a section, unfolding it if it was folded. Where the
 * section marks a current step (the agenda's item in debate), it shows
 * that rather than the section's top. Only the column scrolls: the strip
 * around it clips sideways, and scrollIntoView would slide it.
 */
async function openAt(id: string): Promise<void> {
  opened.value = true;
  lastOpened.value = id;
  await nextTick();
  const key = CSS.escape(id);
  const title = body.value?.querySelector<HTMLElement>(
    `#session-fold-${key}-title`,
  );
  const toggle = title?.querySelector<HTMLElement>("button");
  if (toggle?.getAttribute("aria-expanded") === "false") {
    toggle.click();
    await nextTick();
  }
  const current = body.value?.querySelector<HTMLElement>(
    `#session-fold-${key}-content [aria-current="step"]`,
  );
  if (scroller.value && (current || title)) {
    revealIn(scroller.value, current ?? title!, current ? "nearest" : "start");
  }
  toggle?.focus({ preventScroll: true });
}

/**
 * Escape folds a column opened over the debate (not a pinned one) and
 * gives the focus back to the icon it was opened from. A menu, a popover
 * or a dialog open from it closes first, on its own Escape.
 */
function onEscape(event: KeyboardEvent): void {
  if (event.defaultPrevented || pinnedHere.value || !expanded.value) return;
  if (
    aside.value?.querySelector('[aria-haspopup][aria-expanded="true"]') ||
    window.document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
    )
  ) {
    return;
  }
  clearTimeout(openTimer);
  clearTimeout(closeTimer);
  hovered.value = false;
  opened.value = false;
  void nextTick(() => {
    const icons =
      strip.value?.querySelectorAll<HTMLElement>("[data-rail-item]");
    const back =
      Array.from(icons ?? []).find(
        (icon) => icon.dataset.railItem === lastOpened.value,
      ) ?? icons?.[0];
    back?.focus();
  });
}

// A tap outside a column opened from the strip folds it.
onClickOutside(aside, () => {
  if (opened.value && !hovered.value && !held()) opened.value = false;
});

onBeforeUnmount(() => {
  clearTimeout(openTimer);
  clearTimeout(closeTimer);
});
</script>

<template>
  <!-- Its place in the row: the strip, or the whole column when pinned;
       open and not pinned, it slides over the debate. -->
  <div
    class="relative shrink-0 transition-[width] duration-200 ease-out motion-reduce:transition-none"
    :class="pinnedHere ? 'w-[26rem]' : 'w-14'"
  >
    <aside
      ref="aside"
      :aria-label="t('session.side.label')"
      class="border-default bg-default absolute inset-y-0 end-0 z-40 flex overflow-hidden border-s transition-[width,box-shadow] duration-200 ease-out motion-reduce:transition-none"
      :class="[
        expanded ? 'w-[26rem]' : 'w-14',
        expanded && !pinnedHere ? 'shadow-xl' : '',
      ]"
      @mouseenter="onEnter"
      @mouseleave="onLeave"
      @focusout="onFocusOut"
      @keydown.esc="onEscape"
    >
      <!-- The strip, folded -->
      <nav
        ref="strip"
        :aria-label="t('session.side.strip')"
        class="flex w-14 shrink-0 flex-col items-center gap-1 py-3 transition-opacity duration-200 motion-reduce:transition-none"
        :class="
          expanded ? 'pointer-events-none absolute opacity-0' : 'opacity-100'
        "
        :inert="expanded || undefined"
      >
        <UTooltip
          v-for="item in items"
          :key="item.id"
          :text="item.summary ? `${item.title} · ${item.summary}` : item.title"
          :content="{ side: 'left' }"
        >
          <!-- Its name is the label: what shows under the icon repeats the
               summary for the eye (the clock is read in the section). -->
          <UButton
            color="neutral"
            variant="ghost"
            size="lg"
            class="w-full flex-col justify-center gap-1 px-1 py-2"
            :data-rail-item="item.id"
            :aria-label="
              item.summary ? `${item.title}: ${item.summary}` : item.title
            "
            @click="openAt(item.id)"
          >
            <span class="relative flex">
              <UIcon :name="item.icon" class="size-5" aria-hidden="true" />
              <span
                v-if="item.dot"
                class="absolute -end-1 -top-1 size-2.5 rounded-full ring-2 ring-(--ui-bg)"
                :class="item.dot"
                aria-hidden="true"
              />
            </span>
            <slot name="strip" :item="item" />
            <UBadge
              v-if="item.count"
              size="md"
              color="neutral"
              variant="subtle"
              class="tabular-nums"
              :label="String(item.count)"
              aria-hidden="true"
            />
          </UButton>
        </UTooltip>
      </nav>

      <!-- The sections, open; a fixed width, so nothing reflows as it slides. -->
      <div
        ref="body"
        class="bg-elevated/30 flex min-h-0 w-[26rem] shrink-0 flex-col transition-opacity duration-200 motion-reduce:transition-none"
        :class="expanded ? 'opacity-100' : 'pointer-events-none opacity-0'"
        :inert="!expanded || undefined"
      >
        <div class="flex min-h-2 items-center justify-end px-3 pt-2">
          <UButton
            v-if="wide"
            size="xs"
            color="neutral"
            :variant="pinned ? 'soft' : 'ghost'"
            :icon="pinned ? 'i-lucide-pin-off' : 'i-lucide-pin'"
            :label="pinned ? t('session.side.unpin') : t('session.side.pin')"
            :aria-pressed="pinned"
            @click="pinned = !pinned"
          />
        </div>
        <div
          ref="scroller"
          class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 pt-1 sm:p-4 sm:pt-1"
        >
          <slot />
        </div>
      </div>
    </aside>
  </div>
</template>
