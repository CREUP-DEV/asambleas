<script setup lang="ts">
import type { AmendmentDto, DocumentDto } from "~~/shared/types/api";
import type { Block } from "~~/shared/types/content";
import { blockLabels } from "~~/shared/utils/content/render";
import { touchedBlockIds } from "~~/shared/utils/content/ops";
import {
  amendmentErrorKey,
  amendmentErrorReasons,
  amendmentHistoryVersion,
  type AmendmentOverlap,
  type AmendmentRelationView,
} from "~/composables/amendment/workspace";

/**
 * Everything about one amendment: its changes over the base (with context),
 * justification, authors, outcome, overlaps, the proponent's position,
 * transactional parties, relations, history, and the author actions
 * (edit, submit, delete a draft; withdraw while undecided).
 */
const props = withDefaults(
  defineProps<{
    amendment: AmendmentDto;
    base: Block[];
    document: DocumentDto;
    /** Base URL of the document's amendments: .../amendments. */
    amendmentsUrl: string;
    labelOf: (id: string) => string;
    relations: AmendmentRelationView[];
    /** Amendments it can be related to. */
    candidates: AmendmentDto[];
    overlaps?: AmendmentOverlap[];
    /** Show the close button (off inside a slideover, which has its own). */
    closable?: boolean;
    /** GET .../decisions of the assembly, for admission votes in the history. */
    decisionsUrl?: string;
  }>(),
  { overlaps: () => [], closable: true, decisionsUrl: undefined },
);

const emit = defineEmits<{
  close: [];
  select: [id: string];
  edit: [amendment: AmendmentDto];
  updated: [amendment: AmendmentDto];
  removed: [id: string];
  /** Something changed elsewhere (relations, a conflict): refetch. */
  changed: [];
}>();

const { t, locale } = useI18n();
const api = useApi();
const toast = useToast();
const headingId = useId();
const { member } = useMe();

const url = computed(() => `${props.amendmentsUrl}/${props.amendment.id}`);
const label = computed(() => props.labelOf(props.amendment.id));

const busy = ref<"submit" | "withdraw" | "delete" | null>(null);
const confirming = ref<"withdraw" | "delete" | null>(null);
const reasons = ref<string[]>([]);

watch(
  () => props.amendment.id,
  () => {
    confirming.value = null;
    reasons.value = [];
  },
);

const decided = computed(
  () =>
    props.amendment.status !== "draft" &&
    props.amendment.status !== "submitted",
);
// The shared clock ticks every minute, so a window that closes while the
// page is open is seen as closed, and hydration matches the server.
const now = useAppNow();
const windowClosed = computed(() => {
  const closesAt = toDate(props.document.window.closesAt);
  return Boolean(closesAt && closesAt.getTime() <= now.value);
});
const canManageRelations = computed(
  () =>
    !props.document.finalVote &&
    (props.amendment.can.moderate ||
      props.amendment.can.review ||
      props.document.can.position),
);
const showPosition = computed(
  () => props.amendment.position !== null || props.amendment.can.position,
);

const where = computed(() => {
  const ids = touchedBlockIds(props.amendment.ops);
  if (ids.length === 0) return null;
  const labels = blockLabels(props.base);
  const first = labels.get(ids[0]!);
  if (!first) return null;
  const paragraph =
    first.paragraph > 0
      ? t("amendment.detail.paragraph", { n: first.paragraph })
      : null;
  return [first.heading, paragraph].filter(Boolean).join(" · ") || null;
});

const presenting = computed(() => props.amendment.authors[0] ?? null);
const coAuthors = computed(() => props.amendment.authors.slice(1));

/** Positions, acceptances and relations do not move updatedAt: fold them in. */
const historyVersion = computed(() =>
  amendmentHistoryVersion(
    props.amendment,
    props.relations.map((view) => view.relation.id),
  ),
);

function handleError(error: unknown, fallbackKey: string): void {
  reasons.value = amendmentErrorReasons(error);
  api.notifyError(error, fallbackKey);
  if (api.isConflict(error)) emit("changed");
}

async function submit(): Promise<void> {
  busy.value = "submit";
  reasons.value = [];
  try {
    const updated = await api.send<AmendmentDto>(`${url.value}/submit`);
    toast.add({
      title: t("amendment.detail.submitted"),
      description: updated.late
        ? t("amendment.detail.submittedLate")
        : undefined,
      color: updated.late ? "warning" : "success",
      icon: "i-lucide-send",
    });
    emit("updated", updated);
  } catch (error) {
    handleError(error, "amendment.detail.submitFailed");
  } finally {
    busy.value = null;
  }
}

async function withdraw(): Promise<void> {
  busy.value = "withdraw";
  try {
    const updated = await api.send<AmendmentDto>(`${url.value}/withdraw`);
    confirming.value = null;
    toast.add({
      title: t("amendment.detail.withdrawn"),
      color: "success",
      icon: "i-lucide-undo-2",
    });
    emit("updated", updated);
  } catch (error) {
    handleError(error, "amendment.detail.withdrawFailed");
  } finally {
    busy.value = null;
  }
}

async function remove(): Promise<void> {
  busy.value = "delete";
  try {
    await api.send(url.value, { method: "DELETE" });
    confirming.value = null;
    toast.add({
      title: t("amendment.detail.deleted"),
      color: "success",
      icon: "i-lucide-trash-2",
    });
    emit("removed", props.amendment.id);
  } catch (error) {
    handleError(error, "amendment.detail.deleteFailed");
  } finally {
    busy.value = null;
  }
}
</script>

<template>
  <article class="flex flex-col gap-5" :aria-labelledby="headingId">
    <header class="flex flex-col gap-2">
      <div class="flex items-start gap-2">
        <div class="min-w-0 flex-1">
          <h2
            :id="headingId"
            class="text-highlighted text-lg font-semibold tabular-nums"
          >
            {{ label }}
          </h2>
          <p v-if="where" class="text-muted truncate text-sm">{{ where }}</p>
        </div>
        <UButton
          v-if="closable"
          icon="i-lucide-x"
          color="neutral"
          variant="ghost"
          size="sm"
          :aria-label="t('amendment.detail.close')"
          @click="emit('close')"
        />
      </div>
      <div class="flex flex-wrap items-center gap-1.5">
        <CommonStatusBadge kind="amendment" :value="amendment.status" />
        <CommonStatusBadge
          v-if="amendment.status !== 'draft'"
          kind="admission"
          :value="amendment.admission"
        />
        <UBadge
          v-if="amendment.late"
          color="warning"
          variant="subtle"
          icon="i-lucide-clock-alert"
          :label="t('amendment.late')"
        />
        <UBadge
          color="neutral"
          variant="outline"
          :label="t(`amendment.kinds.${amendment.kind}`)"
        />
        <UBadge
          v-for="change in amendment.changeKinds"
          :key="change"
          color="neutral"
          variant="soft"
          :label="t(`amendment.changeKinds.${change}`)"
        />
      </div>
    </header>

    <UAlert
      v-if="reasons.length > 0"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      role="alert"
      :title="t('amendment.composer.errorsTitle')"
    >
      <template #description>
        <ul class="list-disc ps-5">
          <li v-for="reason in reasons" :key="reason">
            {{ t(amendmentErrorKey(reason)) }}
          </li>
        </ul>
      </template>
    </UAlert>

    <section class="flex flex-col gap-2">
      <h3 class="text-highlighted text-sm font-semibold">
        {{ t("amendment.detail.changes") }}
      </h3>
      <p v-if="amendment.globalReplace" class="text-sm">
        <UIcon
          name="i-lucide-replace-all"
          class="text-muted me-1 size-4 align-text-bottom"
          aria-hidden="true"
        />
        {{
          t("amendment.detail.globalReplace", {
            find: amendment.globalReplace.find,
            replace: amendment.globalReplace.replace,
          })
        }}
        <span class="text-muted">
          ·
          {{
            t(
              "amendment.detail.occurrences",
              { count: amendment.ops.length },
              amendment.ops.length,
            )
          }}
        </span>
      </p>
      <div class="border-default rounded-md border p-3 sm:p-4">
        <ContentAmendmentDiff
          :id="amendment.id"
          :base="base"
          :ops="amendment.ops"
          :focus="amendment.id"
          :context="1"
        >
          <template v-if="amendment.kind === 'totality_return'" #note>
            <UAlert
              color="neutral"
              variant="subtle"
              icon="i-lucide-file-x"
              :title="t('amendment.kinds.totality_return')"
              :description="t('amendment.detail.returnNote')"
            />
          </template>
        </ContentAmendmentDiff>
      </div>
    </section>

    <section class="flex flex-col gap-2">
      <h3 class="text-highlighted text-sm font-semibold">
        {{ t("amendment.detail.justification") }}
      </h3>
      <p
        v-if="amendment.justification"
        class="content-font text-default text-sm whitespace-pre-line"
      >
        {{ amendment.justification }}
      </p>
      <p v-else class="text-muted text-sm">
        {{ t("amendment.detail.noJustification") }}
      </p>
    </section>

    <section class="flex flex-col gap-2">
      <h3 class="text-highlighted text-sm font-semibold">
        {{ t("amendment.detail.authors") }}
      </h3>
      <div class="flex flex-col gap-1.5">
        <div v-if="presenting" class="flex flex-wrap items-center gap-2">
          <CommonMemberBadge :member="presenting" size="xs" show-name />
          <span class="text-dimmed text-xs">
            {{ t("amendment.detail.presenting") }}
          </span>
        </div>
        <CommonMemberBadge
          v-for="author in coAuthors"
          :key="author.id"
          :member="author"
          size="xs"
          show-name
        />
        <p v-if="amendment.submittedAt" class="text-muted text-xs">
          {{
            t("amendment.detail.submittedAt", {
              date: formatDateTime(amendment.submittedAt, { locale }),
            })
          }}
        </p>
      </div>
    </section>

    <section v-if="decided" class="flex flex-col gap-2">
      <h3 class="text-highlighted text-sm font-semibold">
        {{ t("amendment.detail.outcome") }}
      </h3>
      <p
        v-if="amendment.status === 'approved' && amendment.approvalMethod"
        class="text-sm"
      >
        {{
          t("amendment.detail.approvedBy", {
            method: t(`amendment.approvalMethods.${amendment.approvalMethod}`),
          })
        }}
      </p>
      <p v-if="amendment.decidedAt" class="text-muted text-xs">
        {{
          t("amendment.detail.decidedAt", {
            date: formatDateTime(amendment.decidedAt, { locale }),
          })
        }}
      </p>
      <p
        v-if="amendment.outcomeNote"
        class="text-default text-sm whitespace-pre-line"
      >
        {{ amendment.outcomeNote }}
      </p>
      <AmendmentVoteSummary
        v-if="amendment.outcomeVote"
        :vote="amendment.outcomeVote"
      />
    </section>

    <section v-if="overlaps.length > 0" class="flex flex-col gap-2">
      <h3 class="text-highlighted text-sm font-semibold">
        {{ t("amendment.detail.overlaps") }}
      </h3>
      <ul class="flex flex-wrap gap-2">
        <li v-for="overlap in overlaps" :key="overlap.id">
          <UButton
            size="xs"
            :color="overlap.kind === 'same_position' ? 'neutral' : 'warning'"
            variant="soft"
            icon="i-lucide-layers"
            :label="`${labelOf(overlap.id)} · ${t(`amendment.detail.overlapKinds.${overlap.kind}`)}`"
            @click="emit('select', overlap.id)"
          />
        </li>
      </ul>
    </section>

    <section
      v-if="
        amendment.sourceIds.length > 0 || amendment.transactionalIds.length > 0
      "
      class="flex flex-col gap-2"
    >
      <h3 class="text-highlighted text-sm font-semibold">
        {{ t("amendment.detail.transactional") }}
      </h3>
      <div
        v-if="amendment.sourceIds.length > 0"
        class="flex flex-wrap items-center gap-2"
      >
        <span class="text-muted text-sm">{{
          t("amendment.detail.sources")
        }}</span>
        <UButton
          v-for="id in amendment.sourceIds"
          :key="id"
          size="xs"
          color="secondary"
          variant="soft"
          icon="i-lucide-git-merge"
          :label="labelOf(id)"
          @click="emit('select', id)"
        />
      </div>
      <div
        v-if="amendment.transactionalIds.length > 0"
        class="flex flex-wrap items-center gap-2"
      >
        <span class="text-muted text-sm">
          {{ t("amendment.detail.transactedIn") }}
        </span>
        <UButton
          v-for="id in amendment.transactionalIds"
          :key="id"
          size="xs"
          color="secondary"
          variant="soft"
          icon="i-lucide-git-merge"
          :label="labelOf(id)"
          @click="emit('select', id)"
        />
      </div>
    </section>

    <AmendmentAcceptances
      v-if="amendment.kind === 'transactional'"
      :amendment="amendment"
      :url="url"
      :actor-member-id="member?.id ?? null"
      @updated="emit('updated', $event)"
      @conflict="emit('changed')"
    />

    <AmendmentPositionPanel
      v-if="showPosition"
      :amendment="amendment"
      :url="url"
      @updated="emit('updated', $event)"
      @conflict="emit('changed')"
    />

    <AmendmentRelations
      :amendment="amendment"
      :relations="relations"
      :candidates="candidates"
      :label-of="labelOf"
      :amendments-url="amendmentsUrl"
      :can-manage="canManageRelations"
      @changed="emit('changed')"
      @select="emit('select', $event)"
    />

    <AmendmentHistory
      :url="url"
      :version="historyVersion"
      :decisions-url="decisionsUrl"
    />

    <footer
      v-if="
        amendment.can.edit || amendment.can.submit || amendment.can.withdraw
      "
      class="border-default bg-default sticky bottom-0 -mx-1 flex flex-col gap-2 border-t px-1 pt-3 pb-1"
    >
      <UAlert
        v-if="amendment.can.submit && windowClosed"
        color="warning"
        variant="subtle"
        icon="i-lucide-clock-alert"
        :title="t('amendment.composer.lateTitle')"
        :description="t('amendment.composer.lateWarning')"
      />

      <div
        v-if="confirming"
        class="flex flex-wrap items-center gap-2"
        role="group"
      >
        <span class="text-sm">
          {{
            confirming === "delete"
              ? t("amendment.detail.deleteConfirm")
              : t("amendment.detail.withdrawConfirm")
          }}
        </span>
        <UButton
          color="error"
          size="sm"
          :loading="busy === confirming"
          :label="
            confirming === 'delete'
              ? t('amendment.actions.delete')
              : t('amendment.actions.withdraw')
          "
          @click="confirming === 'delete' ? remove() : withdraw()"
        />
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          :disabled="busy !== null"
          :label="t('amendment.actions.cancel')"
          @click="confirming = null"
        />
      </div>

      <div v-else class="flex flex-wrap items-center gap-2">
        <UButton
          v-if="amendment.can.edit"
          icon="i-lucide-pencil"
          color="neutral"
          variant="outline"
          size="sm"
          :label="t('amendment.actions.edit')"
          :disabled="busy !== null"
          @click="emit('edit', amendment)"
        />
        <UButton
          v-if="amendment.can.edit"
          icon="i-lucide-trash-2"
          color="error"
          variant="ghost"
          size="sm"
          :label="t('amendment.actions.delete')"
          :disabled="busy !== null"
          @click="confirming = 'delete'"
        />
        <UButton
          v-if="amendment.can.withdraw"
          icon="i-lucide-undo-2"
          color="neutral"
          variant="outline"
          size="sm"
          :label="t('amendment.actions.withdraw')"
          :disabled="busy !== null"
          @click="confirming = 'withdraw'"
        />
        <UButton
          v-if="amendment.can.submit"
          icon="i-lucide-send"
          size="sm"
          class="ms-auto"
          :loading="busy === 'submit'"
          :disabled="busy !== null"
          :label="t('amendment.actions.submit')"
          @click="submit"
        />
      </div>
    </footer>
  </article>
</template>
