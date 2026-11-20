<script setup lang="ts">
import { useAmendmentLinks } from "~/composables/amendment/amendmentLinks";

/**
 * A sentence already written («Incluida en la transaccional T3», «Choca con
 * US1») whose codes of other amendments become AmendmentCodeLinks: each
 * label of `ids` found in the text, as a whole word, opens a preview of its
 * amendment when clicked where the page provides the links (user's
 * decisions of 2026-11-20). The rest stays as written; without links it is plain text.
 * Without `labelOf`, an amendment is named by its code, as the live notes
 * name it.
 */
const props = defineProps<{
  text: string;
  ids: string[];
  labelOf?: (id: string) => string | null;
  /** Inside a row that is a button: the codes stay text. */
  inert?: boolean;
  /** The preview offers no way to the amendment. */
  previewOnly?: boolean;
}>();

const links = useAmendmentLinks();

function nameOf(id: string): string | null {
  return props.labelOf ? props.labelOf(id) : (links?.get(id)?.code ?? null);
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const parts = computed(() => {
  const byLabel = new Map<string, string>();
  for (const id of props.ids) {
    const label = nameOf(id);
    if (label && !byLabel.has(label)) byLabel.set(label, id);
  }
  if (byLabel.size === 0) return [{ id: null, text: props.text }];
  // Longest first, so «T12» is not read as «T1».
  const labels = [...byLabel.keys()].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])(${labels.map(escape).join("|")})(?![\\p{L}\\p{N}])`,
    "gu",
  );
  const out: { id: string | null; text: string }[] = [];
  let last = 0;
  for (const match of props.text.matchAll(pattern)) {
    const at = match.index;
    if (at > last) out.push({ id: null, text: props.text.slice(last, at) });
    out.push({ id: byLabel.get(match[0]) ?? null, text: match[0] });
    last = at + match[0].length;
  }
  if (last < props.text.length) {
    out.push({ id: null, text: props.text.slice(last) });
  }
  return out;
});

function labelFor(text: string) {
  return () => text;
}
</script>

<template>
  <template v-for="(part, index) in parts" :key="index">
    <AmendmentCodeLinks
      v-if="part.id"
      :ids="[part.id]"
      :label-of="labelFor(part.text)"
      :inert="inert"
      :preview-only="previewOnly"
    />
    <template v-else>{{ part.text }}</template>
  </template>
</template>
