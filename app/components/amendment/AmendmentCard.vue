<script setup lang="ts">
const { t, d } = useI18n();

interface AmendmentAuthor {
  id: string;
  name: string;
  email: string;
  externalInitials: string | null;
}

interface Amendment {
  id: string;
  documentId: string;
  submittedBy: string;
  status: string;
  type: string;
  justification: string;
  parentAmendmentId: string | null;
  createdAt: string;
  submittedAt: string | null;
  author?: AmendmentAuthor;
}

const props = defineProps<{
  amendment: Amendment;
  selected?: boolean;
}>();

const emit = defineEmits<{
  select: [id: string];
}>();

const authorLabel = computed(() => {
  const author = props.amendment.author;
  if (!author) return "";
  return author.externalInitials || author.name || author.email;
});
</script>

<template>
  <div
    class="border-default hover:bg-muted/50 cursor-pointer rounded-lg border p-4 transition-colors"
    :class="{ 'ring-primary ring-2': selected }"
    @click="emit('select', amendment.id)"
  >
    <div class="flex items-start justify-between gap-2">
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <AmendmentStatusBadge
            :status="amendment.status"
            :type="amendment.type"
          />
          <UBadge
            v-if="amendment.type === 'formal'"
            color="info"
            variant="solid"
            size="xs"
          >
            {{ t("amendment.type.formal") }}
          </UBadge>
          <UBadge
            v-if="amendment.parentAmendmentId"
            color="neutral"
            variant="outline"
            size="xs"
          >
            {{ t("amendment.transactional") }}
          </UBadge>
        </div>

        <p class="text-muted mt-2 line-clamp-2 text-sm">
          {{ amendment.justification }}
        </p>
      </div>
    </div>

    <div class="text-muted mt-3 flex items-center gap-3 text-xs">
      <span>{{ t("amendment.author") }}: {{ authorLabel }}</span>
      <span v-if="amendment.submittedAt">
        {{ t("amendment.submittedAt") }}:
        {{ d(new Date(amendment.submittedAt), "short") }}
      </span>
    </div>
  </div>
</template>
