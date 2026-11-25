<script setup lang="ts">
import type {
  AmendmentDto,
  ReviewQueueAmendmentDto,
} from "~~/shared/types/api";
import { amendmentDisplayLabel } from "~/composables/amendment/workspace";
import { justificationLead, passagePlace } from "./-validated";

/**
 * One document in «Publicadas» (ValidatedList): its heading goes to the
 * document and each row to the amendment, with where it acts («3.
 * Devolución · párrafo 2», as the amendment's detail says it) and the first
 * line of its justification, so a validation made by mistake is found
 * without opening each one. The published text is read once per document
 * (the key the rest of the inbox shares), not followed live: it is frozen.
 * «Deshacer la validación» is the list's to confirm (`undo`); each button
 * carries `data-undo-id` so the list can give it the focus.
 */
const props = defineProps<{
  document: ReviewQueueAmendmentDto["document"];
  amendments: AmendmentDto[];
  assemblyId: string;
  /** Localized path of a document of the assembly, by its slug. */
  documentPath: (slug: string) => string;
  /** The amendment whose validation is being taken back, if any. */
  busyId: string | null;
}>();

const emit = defineEmits<{
  undo: [amendment: AmendmentDto];
}>();

const { t } = useI18n();

const { document: fullDocument } = useDocument(
  () => props.assemblyId,
  () => props.document.id,
  { live: false },
);
const base = computed(() => fullDocument.value?.baseVersion?.blocks ?? null);

function labelOf(amendment: AmendmentDto): string {
  return amendmentDisplayLabel(amendment) ?? t("review.amendments.noCode");
}

/** Each row's second and third lines, by amendment id. */
const lines = computed(
  () =>
    new Map(
      props.amendments.map((amendment) => {
        const place = passagePlace(amendment.ops, base.value);
        const paragraph =
          place && place.paragraph > 0
            ? t("amendment.detail.paragraph", { n: place.paragraph })
            : null;
        return [
          amendment.id,
          {
            place:
              [place?.heading, paragraph].filter(Boolean).join(" · ") || null,
            lead: justificationLead(amendment.justification),
          },
        ] as const;
      }),
    ),
);

function amendmentTo(amendment: AmendmentDto) {
  return {
    path: props.documentPath(props.document.slug),
    query: { enmienda: amendment.id },
  };
}
</script>

<template>
  <section class="space-y-2" :aria-labelledby="`validated-${document.id}`">
    <h4
      :id="`validated-${document.id}`"
      class="text-highlighted text-base font-semibold"
    >
      <ULink
        :to="documentPath(document.slug)"
        class="hover:text-primary underline-offset-4 hover:underline"
      >
        {{ document.title }}
      </ULink>
      <span
        v-if="document.reference"
        class="text-muted ms-2 text-sm font-normal"
      >
        {{ document.reference }}
      </span>
    </h4>
    <ul
      class="border-default divide-default divide-y overflow-hidden rounded-lg border"
    >
      <li
        v-for="amendment in amendments"
        :key="amendment.id"
        class="hover:bg-elevated/50 focus-within:bg-elevated/50 relative flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-2.5"
      >
        <div class="min-w-0 flex-1 space-y-1">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <ULink
              :to="amendmentTo(amendment)"
              class="text-highlighted hover:text-primary font-semibold tabular-nums underline-offset-4 after:absolute after:inset-0 hover:underline"
            >
              {{ labelOf(amendment) }}
            </ULink>
            <span class="flex min-w-0 flex-wrap items-center gap-1.5">
              <CommonMemberBadge
                v-for="author in amendment.authors"
                :key="author.id"
                :member="author"
                class="relative z-[1]"
              />
              <UBadge
                v-if="amendment.kind === 'transactional'"
                color="neutral"
                variant="outline"
                size="md"
                :label="t('session.enums.amendmentKind.transactional')"
              />
            </span>
          </div>
          <p v-if="lines.get(amendment.id)?.place" class="text-muted text-sm">
            {{ lines.get(amendment.id)?.place }}
          </p>
          <p
            v-if="lines.get(amendment.id)?.lead"
            class="text-muted line-clamp-1 text-sm"
          >
            {{ lines.get(amendment.id)?.lead }}
          </p>
        </div>
        <UButton
          color="neutral"
          variant="outline"
          size="sm"
          icon="i-lucide-badge-x"
          class="relative z-[1]"
          :data-undo-id="amendment.id"
          :label="t('amendment.validationUndo.undo')"
          :aria-label="
            t('review.validated.undoLabel', { label: labelOf(amendment) })
          "
          :loading="busyId === amendment.id"
          :disabled="busyId !== null && busyId !== amendment.id"
          @click="emit('undo', amendment)"
        />
      </li>
    </ul>
  </section>
</template>
