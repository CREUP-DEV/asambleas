<script setup lang="ts">
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";
import { numberedAgendaTitle } from "~/utils/agendaTree";
import { scrollParentOf } from "~/utils/scrollAnchor";

/**
 * «Ahora en debate» folded into one line, stuck to the top of the debate
 * column once the card itself scrolls out of view, so the Mesa reads the
 * document below with one scroll and keeps what is debated and the way on
 * at hand (user's decision of 2026-11-18). It names what is on screen and
 * offers the pointer's controls (session.pointerTools, the same as above
 * the document) and a way back up to the card. Marked `data-sticky-now`:
 * the document preview reads the view's top below it.
 *
 * It takes no room in the column (a sticky line of no height, the bar over
 * it), so showing it never moves the text, and the card counts as gone once
 * it is under the bar: putting a document in debate scrolls its start just
 * below it (SessionAmendmentQueue).
 */
const props = defineProps<{ target: HTMLElement | null }>();

const session = useSessionConsoleContext();
const { t } = useI18n();

const folded = ref(false);
let observer: IntersectionObserver | null = null;
watch(
  () => props.target,
  (target) => {
    observer?.disconnect();
    if (!target) return;
    observer = new IntersectionObserver(
      ([entry]) => {
        folded.value = !entry?.isIntersecting;
      },
      // The top of the column, under the bar, does not count as in view.
      {
        root: scrollParentOf(target),
        rootMargin: "-72px 0px 0px 0px",
        threshold: 0,
      },
    );
    observer.observe(target);
  },
  { immediate: true, flush: "post" },
);
onBeforeUnmount(() => observer?.disconnect());

const live = computed(() => session.liveState.value);
const liveRow = computed(() => {
  const id = live.value?.agendaItemId;
  return id
    ? (session.agendaRows.value.find((row) => row.item.id === id) ?? null)
    : null;
});
const title = computed(() => {
  const documentId = live.value?.documentId;
  if (documentId) {
    for (const row of session.agendaRows.value) {
      const found = row.documents.find((entry) => entry.id === documentId);
      if (found) return found.title;
    }
  }
  return liveRow.value
    ? numberedAgendaTitle(
        liveRow.value.number,
        liveRow.value.item.title,
        t("agenda.unlisted.inText"),
      )
    : null;
});
const tools = session.pointerTools;

function backUp(): void {
  props.target?.scrollIntoView({ block: "start", behavior: "smooth" });
}
</script>

<template>
  <!-- A sticky line of no height (and no gap after it): the bar hangs from it. -->
  <div class="sticky -top-3 z-30 -mb-4 h-0 sm:-top-4">
    <div
      v-show="folded && title"
      data-sticky-now
      class="border-primary/40 bg-default/95 absolute inset-x-0 top-0 -mx-1 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-1.5 shadow-sm backdrop-blur"
    >
      <UIcon
        name="i-lucide-radio"
        class="text-primary size-4 shrink-0"
        aria-hidden="true"
      />
      <p class="min-w-0 flex-1 truncate text-sm">
        <span
          class="text-primary text-xs font-semibold tracking-wide uppercase"
        >
          {{ t("session.now.title") }}
        </span>
        <span class="text-highlighted ms-2 font-medium">{{ title }}</span>
      </p>
      <template v-if="tools.available">
        <UButton
          size="xs"
          :color="tools.on ? 'primary' : 'neutral'"
          :variant="tools.on ? 'soft' : 'outline'"
          icon="i-lucide-mouse-pointer-click"
          :label="t('session.pointer.toggle')"
          :aria-pressed="tools.on"
          @click="tools.on = !tools.on"
        />
        <template v-if="tools.on">
          <SessionPointerMode v-if="tools.text" size="xs" />
          <USwitch
            v-model="tools.pinned"
            size="xs"
            :label="t('session.pointer.pin')"
          />
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-eraser"
            :label="t('session.pointer.clear')"
            @click="tools.clears++"
          />
        </template>
      </template>
      <UButton
        size="xs"
        color="neutral"
        variant="ghost"
        icon="i-lucide-arrow-up"
        :label="t('session.nowBar.backUp')"
        @click="backUp"
      />
    </div>
  </div>
</template>
