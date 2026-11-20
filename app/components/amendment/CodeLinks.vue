<script setup lang="ts">
import { useAmendmentLinks } from "~/composables/amendment/amendmentLinks";

/**
 * Codes of other amendments inside a sentence («Sustituye a 2 · UEX2 y
 * 3 · UM4»), joined the way the locale joins lists, or one code alone
 * (`ids` of one). Where the page provides the amendment links
 * (provideAmendmentLinks, user's decisions of 2026-11-20), clicking a code
 * opens its preview (who presents it, where it stands and what it changes)
 * and, where the page can open it, «Ver la enmienda» goes to it; nothing
 * opens on hover, so it works the same on a tablet. A page with a preview
 * window of its own (`inWindow`) opens that window instead. Elsewhere, or
 * for an amendment the reader does not have, the code is plain text.
 *
 * `inert`: inside something that is already a button (a row of a list), a
 * button cannot nest: the code is plain text and a click goes to the row.
 * `previewOnly`: the preview offers no way to the amendment (a dialog that
 * would be left open behind it).
 */
const props = defineProps<{
  ids: string[];
  labelOf: (id: string) => string;
  inert?: boolean;
  previewOnly?: boolean;
}>();

const { locale } = useI18n();
const links = useAmendmentLinks();

/** The list as the locale writes it, each element with its amendment. */
const parts = computed(() => {
  const labels = props.ids.map((id) => props.labelOf(id));
  let formatted: { type: string; value: string }[];
  try {
    formatted = new Intl.ListFormat(locale.value, {
      style: "long",
      type: "conjunction",
    }).formatToParts(labels);
  } catch {
    formatted = labels.flatMap((value, index) => [
      ...(index > 0 ? [{ type: "literal", value: ", " }] : []),
      { type: "element", value },
    ]);
  }
  let next = 0;
  return formatted.map((part) =>
    part.type === "element"
      ? { kind: "code" as const, id: props.ids[next++]!, text: part.value }
      : { kind: "text" as const, id: null, text: part.value },
  );
});

/** The code whose preview is open, by its place in the sentence. */
const openIndex = ref<number | null>(null);

function linked(id: string | null): boolean {
  return Boolean(!props.inert && id && links?.get(id));
}

function open(id: string) {
  openIndex.value = null;
  links?.open?.(id);
}

const canOpen = computed(() => !props.previewOnly && Boolean(links?.open));
const CODE_CLASS =
  "hover:text-primary decoration-dimmed cursor-pointer font-semibold underline decoration-dotted underline-offset-4";
</script>

<template>
  <template v-for="(part, index) in parts" :key="index">
    <template v-if="part.kind === 'text' || !linked(part.id)">{{
      part.text
    }}</template>
    <!-- The page previews in a window of its own: the code opens it. -->
    <button
      v-else-if="links?.inWindow && links.open"
      type="button"
      :class="CODE_CLASS"
      @click.stop="open(part.id!)"
    >
      {{ part.text }}
    </button>
    <UPopover
      v-else-if="links"
      :open="openIndex === index"
      :content="{ side: 'top', align: 'start' }"
      @update:open="openIndex = $event ? index : null"
    >
      <button type="button" :class="CODE_CLASS" @click.stop>
        {{ part.text }}
      </button>
      <template #content>
        <AmendmentLinkPreview
          :amendment="links.get(part.id!)!"
          :label="part.text"
          :base="links.baseOf(part.id!)"
          :can-open="canOpen"
          @open="open(part.id!)"
        />
      </template>
    </UPopover>
  </template>
</template>
