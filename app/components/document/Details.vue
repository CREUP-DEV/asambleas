<script setup lang="ts">
import type { DocumentSummaryDto } from "~~/shared/types/api";
import { documentCoPresenters } from "~/composables/document/documentPresenters";
import { formatDateTime } from "~/utils/format";

/**
 * What a document is, behind an icon beside its title, so the header keeps
 * one line: its kind and reference, who presents it (and, with several
 * presenters, the main one), when it was published and its amendment
 * window. A mouse opens it by resting on the icon, without taking the
 * focus; a click, a tap or the keyboard opens it as a dialog, which stays
 * until it is closed.
 */
const props = defineProps<{
  document: DocumentSummaryDto;
}>();

const { t, locale } = useI18n();

const open = ref(false);
/** Opened by a mouse resting on it: it never takes the focus then. */
const byHover = ref(false);
/** A press while it is open from hovering keeps it open instead. */
let pinning = false;
let timer: ReturnType<typeof setTimeout> | undefined;

function later(value: boolean, delay: number) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    open.value = value;
  }, delay);
}
function hoverIn(event: PointerEvent) {
  if (event.pointerType !== "mouse") return;
  if (!open.value) byHover.value = true;
  if (byHover.value) later(true, 200);
}
function hoverOut(event: PointerEvent) {
  if (event.pointerType !== "mouse" || !byHover.value) return;
  later(false, 150);
}
function press() {
  pinning = open.value && byHover.value;
}
/**
 * What the popover itself asks: opening comes only from a click, a tap or
 * the keyboard, so it stays until closed; hovering sets `open` directly.
 */
function setOpen(value: boolean) {
  clearTimeout(timer);
  if (value || pinning) {
    // A click while hovering had opened it keeps it, now as a dialog.
    byHover.value = false;
    open.value = true;
  } else {
    open.value = false;
  }
  pinning = false;
}
watch(open, (value) => {
  if (!value) byHover.value = false;
});
onBeforeUnmount(() => clearTimeout(timer));

const content = computed(() => ({
  align: "start" as const,
  onOpenAutoFocus: (event: Event) => {
    if (byHover.value) event.preventDefault();
  },
  onPointerenter: (event: PointerEvent) => hoverIn(event),
  onPointerleave: (event: PointerEvent) => hoverOut(event),
}));

/** The main presenter, named apart when others present it too. */
const mainPresenter = computed(() =>
  documentCoPresenters(props.document).length > 0
    ? props.document.proponent
    : null,
);

const longDate = (value: string | null) =>
  value ? formatDateTime(value, { locale: locale.value, style: "long" }) : "";

const amendmentWindow = computed(() => {
  const document = props.document;
  if (
    document.format !== "structured" ||
    !document.amendable ||
    document.status !== "published"
  ) {
    return null;
  }
  const { opensAt, closesAt } = document.window;
  if (opensAt && closesAt) {
    return t("document.details.windowRange", {
      opens: longDate(opensAt),
      closes: longDate(closesAt),
    });
  }
  if (closesAt) {
    return t("document.details.windowUntil", { closes: longDate(closesAt) });
  }
  return null;
});
</script>

<template>
  <UPopover :open="open" :content="content" @update:open="setOpen">
    <UButton
      icon="i-lucide-info"
      color="neutral"
      variant="ghost"
      size="sm"
      class="shrink-0"
      :aria-label="t('document.details.label')"
      data-testid="document-details"
      @pointerenter="hoverIn"
      @pointerleave="hoverOut"
      @pointerdown="press"
    />
    <template #content>
      <dl
        class="grid w-max max-w-sm grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 p-3 text-sm"
      >
        <dt class="text-muted">{{ t("document.details.kind") }}</dt>
        <dd class="text-default">
          {{ t(`document.kinds.${document.kind}`) }}
        </dd>

        <template v-if="document.reference">
          <dt class="text-muted">{{ t("document.header.reference") }}</dt>
          <dd class="text-default font-medium tabular-nums">
            {{ document.reference }}
          </dd>
        </template>

        <template v-if="document.proponent">
          <dt class="text-muted">{{ t("document.header.proponent") }}</dt>
          <dd class="min-w-0">
            <DocumentPresenters :document="document" show-name />
          </dd>
        </template>

        <template v-if="mainPresenter">
          <dt class="text-muted">{{ t("document.presenters.main") }}</dt>
          <dd class="text-default">
            {{
              memberNameRepeatsAcronym(mainPresenter)
                ? mainPresenter.acronym
                : mainPresenter.name
            }}
          </dd>
        </template>

        <template v-if="document.publishedAt">
          <dt class="text-muted">{{ t("document.details.published") }}</dt>
          <dd class="text-default">
            <time :datetime="document.publishedAt">{{
              longDate(document.publishedAt)
            }}</time>
          </dd>
        </template>

        <template v-if="amendmentWindow">
          <dt class="text-muted">{{ t("document.details.window") }}</dt>
          <dd class="text-default">{{ amendmentWindow }}</dd>
        </template>
      </dl>
    </template>
  </UPopover>
</template>
