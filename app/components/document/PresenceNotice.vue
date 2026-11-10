<script setup lang="ts">
import type { DocumentEditorPresenceDto } from "~~/shared/types/api";
import { listSegments } from "~/composables/document/documentPresenters";

/**
 * One quiet line above the draft editor naming who else has it open
 * (useDocumentPresence) and who of them holds unsaved changes, the case
 * that ends in a save conflict. Nothing shows while nobody else is there.
 * A polite status region repeats it for screen readers, which hear it only
 * when its text changes, never on each heartbeat.
 */
const props = defineProps<{ editors: DocumentEditorPresenceDto[] }>();

const { t, locale } = useI18n();

function labelOf(editor: DocumentEditorPresenceDto): string {
  if (editor.sameAccount) return t("document.authoring.presence.sameAccount");
  if (editor.name && editor.member) {
    return `${editor.name} (${editor.member.acronym})`;
  }
  if (editor.name) return editor.name;
  // Withheld person (a CEA office, for those who may not see the offices).
  if (editor.member) {
    return t("document.authoring.presence.fromMember", {
      member: editor.member.acronym,
    });
  }
  return t("document.authoring.presence.someone");
}

/** One entry per label: two tabs of one person read as one person. */
const people = computed(() => {
  const byLabel = new Map<string, boolean>();
  for (const editor of props.editors) {
    const label = labelOf(editor);
    byLabel.set(label, (byLabel.get(label) ?? false) || editor.unsaved);
  }
  return [...byLabel].map(([label, unsaved]) => ({ label, unsaved }));
});

function joined(labels: string[]): string {
  return listSegments(labels.length, locale.value)
    .map((part) => (part.kind === "item" ? labels[part.index] : part.value))
    .join("");
}

function sentence(text: string): string {
  return text.charAt(0).toLocaleUpperCase(locale.value) + text.slice(1);
}

/** Those with unsaved changes first: they are the ones to wait for. */
const text = computed(() => {
  const groups: [string, string[]][] = [
    [
      "document.authoring.presence.editingUnsaved",
      people.value.filter((p) => p.unsaved).map((p) => p.label),
    ],
    [
      "document.authoring.presence.editing",
      people.value.filter((p) => !p.unsaved).map((p) => p.label),
    ],
  ];
  return groups
    .filter(([, labels]) => labels.length > 0)
    .map(([key, labels]) =>
      sentence(t(key, { names: joined(labels) }, labels.length)),
    )
    .join(" ");
});
</script>

<template>
  <!-- Always there, so screen readers hear the line when it appears; out of
       the layout (sr-only), so it adds no gap while nobody else edits -->
  <p class="sr-only" role="status" aria-live="polite">{{ text }}</p>
  <p
    v-if="text"
    class="text-muted flex items-start gap-1.5 text-sm"
    aria-hidden="true"
    data-testid="draft-presence"
  >
    <UIcon name="i-lucide-users" class="mt-0.5 size-4 shrink-0" />
    <span>{{ text }}</span>
  </p>
</template>
