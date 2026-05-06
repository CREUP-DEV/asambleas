<script setup lang="ts">
interface ContentHistoryEntry {
  contentHash: string;
  amendmentId: string;
  type: "formal" | "accepted_proponent" | "approved_vote";
  incorporatedAt: string;
}

interface AmendmentAuthor {
  id: string;
  name: string;
  email: string;
  externalInitials: string | null;
}

interface Amendment {
  id: string;
  status: string;
  type: string;
  author?: AmendmentAuthor;
}

const props = defineProps<{
  history: ContentHistoryEntry[];
  amendments: Amendment[];
}>();

const { t, d } = useI18n();

const amendmentById = computed(
  () => new Map(props.amendments.map((amendment) => [amendment.id, amendment])),
);

const authorLabel = (amendment: Amendment | undefined) => {
  const author = amendment?.author;
  return author?.externalInitials || author?.name || author?.email || "";
};
</script>

<template>
  <section v-if="history.length > 0" class="space-y-3">
    <h3 class="text-lg font-semibold">{{ t("document.timeline") }}</h3>
    <ol class="space-y-2 border-l border-default pl-4">
      <li v-for="entry in history" :key="entry.amendmentId" class="text-sm">
        <div class="flex flex-wrap items-center gap-2">
          <AmendmentStatusBadge :status="entry.type" :type="entry.type" />
          <span class="font-medium">
            {{ authorLabel(amendmentById.get(entry.amendmentId)) }}
          </span>
          <span class="text-muted">
            {{ d(new Date(entry.incorporatedAt), "short") }}
          </span>
        </div>
        <p class="text-muted mt-1 font-mono text-xs">
          {{ entry.contentHash }}
        </p>
      </li>
    </ol>
  </section>
</template>
