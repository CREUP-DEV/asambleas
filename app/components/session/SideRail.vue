<script setup lang="ts">
/**
 * The console's side column (speakers, headcounts, agenda, final text)
 * folded into a strip of icons along the right edge, so the debate takes
 * the width (user's decision of 2026-11-19). Resting the mouse on it opens
 * it over the debate, sliding in, and it folds again a moment after the
 * mouse leaves. It stays open while something opened from it is open (a
 * menu, a popover, a dialog) and while the keyboard is inside it. «Fijar»
 * keeps it open beside the debate, remembered per browser. An icon of the
 * strip opens it at its section, by mouse, touch or keyboard.
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
}

defineProps<{ items: SideRailItem[] }>();

const { t } = useI18n();

const pinned = useLocalStorage("session-side-pinned", false);
const hovered = ref(false);
/** Opened from the strip (a click, a tap or the keyboard). */
const opened = ref(false);
const expanded = computed(() => pinned.value || hovered.value || opened.value);

const aside = ref<HTMLElement | null>(null);
const body = ref<HTMLElement | null>(null);

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

async function openAt(id: string): Promise<void> {
  opened.value = true;
  await nextTick();
  const section = body.value?.querySelector<HTMLElement>(
    `#session-fold-${CSS.escape(id)}-title`,
  );
  section?.scrollIntoView({ block: "start", behavior: "smooth" });
  section?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
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
    :class="pinned ? 'w-[26rem]' : 'w-14'"
  >
    <aside
      ref="aside"
      :aria-label="t('session.side.label')"
      class="border-default bg-default absolute inset-y-0 end-0 z-40 flex overflow-hidden border-s transition-[width,box-shadow] duration-200 ease-out motion-reduce:transition-none"
      :class="[
        expanded ? 'w-[26rem]' : 'w-14',
        expanded && !pinned ? 'shadow-xl' : '',
      ]"
      @mouseenter="onEnter"
      @mouseleave="onLeave"
      @focusout="onFocusOut"
    >
      <!-- The strip, folded -->
      <nav
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
          <UButton
            color="neutral"
            variant="ghost"
            size="lg"
            :icon="item.icon"
            :aria-label="
              item.summary ? `${item.title}: ${item.summary}` : item.title
            "
            @click="openAt(item.id)"
          />
        </UTooltip>
      </nav>

      <!-- The sections, open; a fixed width, so nothing reflows as it slides. -->
      <div
        ref="body"
        class="bg-elevated/30 flex min-h-0 w-[26rem] shrink-0 flex-col transition-opacity duration-200 motion-reduce:transition-none"
        :class="expanded ? 'opacity-100' : 'pointer-events-none opacity-0'"
        :inert="!expanded || undefined"
      >
        <div class="flex items-center justify-end px-3 pt-2">
          <UButton
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
          class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 pt-1 sm:p-4 sm:pt-1"
        >
          <slot />
        </div>
      </div>
    </aside>
  </div>
</template>
