<script setup lang="ts">
import type {
  AmendmentDto,
  ReviewQueueAmendmentDto,
  ReviewValidatedDto,
  UndoValidationBody,
} from "~~/shared/types/api";
import { amendmentDisplayLabel } from "~/composables/amendment/workspace";
import { affectsReviewQueue } from "./-live";

/**
 * «Validadas» in the validation inbox (user's decision of 2026-11-20): the
 * amendments the Secretaría validated and published that are still
 * undecided (GET .../review/validated), by document, so a validation made
 * by mistake is taken back from here. Each row goes to the amendment (its
 * code) and its document heading to the document; «Deshacer la validación»
 * (POST .../unvalidate) sends it back to «Por revisar» as it is, after
 * saying what that does: everyone stops seeing it and, if its presenter
 * answered, the answer goes back to pending. Sending it back to its authors
 * with a note stays on the amendment's page («Devolver para corregir»).
 *
 * Read only while the tab is open (`active`), the first time and on live
 * changes then, so the inbox never carries the whole list. `undone` tells
 * the page the amendment is back to review.
 */
const props = defineProps<{
  active: boolean;
  apiBase: string;
  /** Localized path of a document of the assembly, by its slug. */
  documentPath: (slug: string) => string;
  /** The page's filters: one document, or one member among the authors. */
  documentId?: string;
  memberId?: string;
}>();

const emit = defineEmits<{
  undone: [amendment: AmendmentDto];
  /** How many there are, once read. */
  count: [count: number];
  announce: [message: string];
}>();

const { t } = useI18n();
const api = useApi();
const toast = useToast();
const { onLive } = useCurrentAssembly();

const rows = ref<ReviewQueueAmendmentDto[] | null>(null);
const loading = ref(false);
const failed = ref(false);
let loadedOnce = false;
let stale = false;

async function load(): Promise<void> {
  if (loading.value) {
    stale = true;
    return;
  }
  loading.value = true;
  failed.value = false;
  try {
    const data = await api.get<ReviewValidatedDto>(
      `${props.apiBase}/review/validated`,
    );
    rows.value = data.amendments;
    loadedOnce = true;
  } catch {
    failed.value = true;
  } finally {
    loading.value = false;
    if (stale) {
      stale = false;
      void load();
    }
  }
}

watch(
  () => props.active,
  (active) => {
    if (active) void load();
  },
  { immediate: true },
);

// Something changed while it is shown: read it again. Hidden, the next
// opening reads it.
onLive((events) => {
  if (!affectsReviewQueue(events)) return;
  if (props.active) void load();
  else if (loadedOnce) rows.value = null;
});

/** The rows the page's filters keep; the tab counts these. */
const shownRows = computed(() =>
  (rows.value ?? []).filter(
    (row) =>
      (props.documentId === undefined ||
        row.document.id === props.documentId) &&
      (props.memberId === undefined ||
        row.amendment.authors.some((author) => author.id === props.memberId)),
  ),
);
watch(
  () => (rows.value === null ? null : shownRows.value.length),
  (count) => {
    if (count !== null) emit("count", count);
  },
);

/** By document, in the order the server sends them (agenda, then text). */
const groups = computed(() => {
  const result: {
    document: ReviewQueueAmendmentDto["document"];
    amendments: AmendmentDto[];
  }[] = [];
  for (const row of shownRows.value) {
    const last = result.at(-1);
    if (last && last.document.id === row.document.id) {
      last.amendments.push(row.amendment);
    } else {
      result.push({ document: row.document, amendments: [row.amendment] });
    }
  }
  return result;
});

function labelOf(amendment: AmendmentDto): string {
  return amendmentDisplayLabel(amendment) ?? t("review.amendments.noCode");
}

function amendmentTo(slug: string, amendment: AmendmentDto) {
  return {
    path: props.documentPath(slug),
    query: { enmienda: amendment.id },
  };
}

// Undo ---------------------------------------------------------------------------

const target = ref<{ amendment: AmendmentDto; slug: string } | null>(null);
const busyId = ref<string | null>(null);
/** The code the dialog names, kept while it closes. */
const shownLabel = ref("");
watch(target, (value) => {
  if (value) shownLabel.value = labelOf(value.amendment);
});
const confirmOpen = computed({
  get: () => target.value !== null,
  set: (open: boolean) => {
    if (!open && !busyId.value) target.value = null;
  },
});

/** Its presenter answered: going back clears the answer. */
function answered(amendment: AmendmentDto): boolean {
  return (
    amendment.position !== null && amendment.position.position !== "pending"
  );
}

const consequences = computed(() => {
  const amendment = target.value?.amendment;
  if (!amendment) return [];
  return [
    t("amendment.validationUndo.hides"),
    answered(amendment) ? t("amendment.validationUndo.clearsAnswer") : null,
  ].filter((line): line is string => line !== null);
});

async function undo(): Promise<void> {
  const current = target.value;
  if (!current || busyId.value) return;
  const { amendment } = current;
  busyId.value = amendment.id;
  try {
    const body: UndoValidationBody = { updatedAt: amendment.updatedAt };
    const updated = await api.send<AmendmentDto>(
      `${props.apiBase}/documents/${encodeURIComponent(amendment.documentId)}/amendments/${encodeURIComponent(amendment.id)}/unvalidate`,
      { method: "POST", body: { ...body } },
    );
    rows.value = (rows.value ?? []).filter(
      (row) => row.amendment.id !== amendment.id,
    );
    const title = t("review.amendments.done.unvalidated", {
      label: labelOf(amendment),
    });
    const description = t("amendment.validationUndo.undoneHidden");
    emit("announce", `${title}. ${description}`);
    toast.add({
      title,
      description,
      color: "success",
      icon: "i-lucide-badge-x",
    });
    emit("undone", updated);
  } catch (error) {
    api.notifyError(error, "amendment.validationUndo.failed");
    if (api.isConflict(error) || api.errorStatus(error) === 404) void load();
  } finally {
    busyId.value = null;
    target.value = null;
  }
}
</script>

<template>
  <div class="space-y-4">
    <p class="text-muted max-w-3xl text-sm">
      {{ t("review.validated.help") }}
    </p>

    <div
      v-if="rows === null && (loading || !failed)"
      class="space-y-2"
      role="status"
    >
      <span class="sr-only">{{ t("review.validated.loading") }}</span>
      <USkeleton
        v-for="index in 3"
        :key="index"
        aria-hidden="true"
        class="h-12 w-full"
      />
    </div>
    <div v-else-if="failed && rows === null" class="space-y-2">
      <p class="text-error text-sm">{{ t("review.validated.loadError") }}</p>
      <UButton
        color="neutral"
        variant="outline"
        size="sm"
        icon="i-lucide-refresh-ccw"
        :label="t('review.retry')"
        :loading="loading"
        @click="load"
      />
    </div>
    <p v-else-if="groups.length === 0" class="text-muted text-sm">
      {{
        (rows?.length ?? 0) > 0
          ? t("review.validated.filtered")
          : t("review.validated.none")
      }}
    </p>

    <div v-else class="space-y-6">
      <section
        v-for="group in groups"
        :key="group.document.id"
        class="space-y-2"
        :aria-labelledby="`validated-${group.document.id}`"
      >
        <h4
          :id="`validated-${group.document.id}`"
          class="text-highlighted text-base font-semibold"
        >
          <ULink
            :to="documentPath(group.document.slug)"
            class="hover:text-primary underline-offset-4 hover:underline"
          >
            {{ group.document.title }}
          </ULink>
          <span
            v-if="group.document.reference"
            class="text-muted ms-2 text-sm font-normal"
          >
            {{ group.document.reference }}
          </span>
        </h4>
        <ul class="border-default divide-default divide-y rounded-lg border">
          <li
            v-for="amendment in group.amendments"
            :key="amendment.id"
            class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5"
          >
            <ULink
              :to="amendmentTo(group.document.slug, amendment)"
              class="text-highlighted hover:text-primary font-semibold tabular-nums underline-offset-4 hover:underline"
            >
              {{ labelOf(amendment) }}
            </ULink>
            <span class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
              <CommonMemberBadge
                v-for="author in amendment.authors"
                :key="author.id"
                :member="author"
              />
              <UBadge
                v-if="amendment.kind === 'transactional'"
                color="neutral"
                variant="outline"
                size="sm"
                :label="t('session.enums.amendmentKind.transactional')"
              />
            </span>
            <UButton
              color="neutral"
              variant="outline"
              size="sm"
              icon="i-lucide-badge-x"
              :label="t('amendment.validationUndo.undo')"
              :aria-label="
                t('review.validated.undoLabel', { label: labelOf(amendment) })
              "
              :loading="busyId === amendment.id"
              :disabled="busyId !== null && busyId !== amendment.id"
              @click="target = { amendment, slug: group.document.slug }"
            />
          </li>
        </ul>
      </section>
    </div>

    <UModal
      v-model:open="confirmOpen"
      :title="t('review.validated.confirmTitle', { label: shownLabel })"
      :description="t('amendment.validationUndo.confirmDescription')"
      :dismissible="busyId === null"
    >
      <template #body>
        <ul class="text-default list-disc space-y-1 ps-5 text-sm">
          <li v-for="line in consequences" :key="line">{{ line }}</li>
        </ul>
      </template>
      <template #footer>
        <div class="flex w-full flex-wrap justify-end gap-2">
          <UButton
            color="neutral"
            variant="outline"
            :label="t('common.cancel')"
            :disabled="busyId !== null"
            @click="target = null"
          />
          <UButton
            color="warning"
            icon="i-lucide-badge-x"
            :label="t('amendment.validationUndo.undo')"
            :loading="busyId !== null"
            @click="undo"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
