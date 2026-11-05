<script lang="ts">
import {
  homeWorkAmendmentQuery,
  type HomeWorkTask,
  type HomeWorkTaskKind,
} from "~/components/home/-work";
import { assemblyPath } from "~/components/shell/Navigation.vue";

/**
 * Unlocalized path where a task is done: the document editor, the
 * presenter's review of the document's amendments, or the document with the
 * amendment (or the transactional to answer) open.
 */
export function homeTaskPath(task: HomeWorkTask): string {
  const base = `${assemblyPath(task.assembly.slug, "documents")}/${encodeURIComponent(task.document.slug)}`;
  switch (task.target) {
    case "edit":
      return `${base}/editar`;
    case "review":
      return `${base}/revisar`;
    default:
      return `${base}${homeWorkAmendmentQuery(task.amendment)}`;
  }
}

const TASK_ICONS: Record<HomeWorkTaskKind, string> = {
  document_correction: "i-lucide-pencil-line",
  amendment_correction: "i-lucide-pencil-line",
  transactional_answer: "i-lucide-handshake",
  proponent_review: "i-lucide-message-square-reply",
  document_prepare: "i-lucide-file-plus",
  document_send: "i-lucide-send",
  amendment_draft: "i-lucide-file-pen-line",
};
</script>

<script setup lang="ts">
/**
 * The things a user has to do, one row each: what it is, a sentence that
 * says what to do (for a main presenter, how many amendments wait for an
 * answer; for a transactional, which of the user's amendments it would
 * replace), the Secretaría's note when it asked for a correction, the
 * deadline of an expected document, and one button that goes where it is
 * done. With `primary`, the first row carries the screen's primary action;
 * every other button stays secondary.
 */
const props = withDefaults(
  defineProps<{
    tasks: HomeWorkTask[];
    /** Name the assembly of each task (off inside an assembly). */
    showAssembly?: boolean;
    /** Button under the text, for narrow columns. */
    compact?: boolean;
    /** The first row's button is the screen's primary action. */
    primary?: boolean;
  }>(),
  { showAssembly: true, compact: false, primary: true },
);

const { t, locale } = useI18n();
const localePath = useLocalePath();

function title(task: HomeWorkTask): string {
  if (!task.amendment) return task.document.title;
  if (task.kind === "transactional_answer") {
    return t("home.work.transactional", { code: task.amendment.code ?? "" });
  }
  return task.amendment.code
    ? t("home.work.amendment", { code: task.amendment.code })
    : t("home.work.amendmentDraft");
}

function context(task: HomeWorkTask): string {
  const parts: string[] = [];
  if (task.amendment) {
    parts.push(t("home.work.amendmentTo", { document: task.document.title }));
  }
  if (props.showAssembly) parts.push(task.assembly.label);
  return parts.join(" · ");
}

/** What the row says has to be done, one sentence per line. */
function sentences(task: HomeWorkTask): string[] {
  if (task.kind === "transactional_answer") {
    const codes = task.replaces
      .map((amendment) => amendment.code)
      .filter(Boolean)
      .join(", ");
    return [
      codes
        ? t(
            "home.work.tasks.transactional_answer.text",
            { codes },
            task.replaces.length,
          )
        : t("home.work.tasks.transactional_answer.textNoCode"),
    ];
  }
  const counts = task.counts;
  if (task.kind === "proponent_review" && counts) {
    return [
      t(
        "home.work.tasks.proponent_review.positions",
        { count: counts.positions },
        counts.positions,
      ),
    ];
  }
  return [t(`home.work.tasks.${task.kind}.text`)];
}

function dueDate(task: HomeWorkTask): string {
  return formatDate(task.dueAt, { locale: locale.value, style: "medium" });
}

const isCorrection = (task: HomeWorkTask) =>
  task.kind === "document_correction" || task.kind === "amendment_correction";
</script>

<template>
  <ul class="divide-default -my-3 divide-y">
    <li
      v-for="(task, index) in tasks"
      :key="task.key"
      class="flex gap-3 py-3"
      :class="compact ? 'flex-col' : 'flex-col sm:flex-row sm:items-start'"
      :data-task="task.kind"
    >
      <div class="flex min-w-0 flex-1 gap-3">
        <span
          class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full"
          :class="
            isCorrection(task) || task.overdue
              ? 'bg-warning/10 text-warning'
              : 'bg-primary/10 text-primary'
          "
          aria-hidden="true"
        >
          <UIcon :name="TASK_ICONS[task.kind]" class="size-4" />
        </span>
        <div class="min-w-0 flex-1 space-y-1">
          <p class="text-highlighted font-medium break-words">
            {{ title(task) }}
          </p>
          <p v-if="context(task)" class="text-muted text-xs break-words">
            {{ context(task) }}
          </p>
          <p
            v-for="(sentence, line) in sentences(task)"
            :key="line"
            class="text-default text-sm"
          >
            {{ sentence }}
          </p>
          <p
            v-if="task.note"
            class="text-default border-warning/60 bg-warning/5 rounded-e-md border-s-2 px-2 py-1 text-sm whitespace-pre-line"
          >
            <span class="text-highlighted font-medium">{{
              t("home.work.note")
            }}</span>
            {{ task.note }}
          </p>
          <p
            v-if="task.dueAt"
            class="flex flex-wrap items-center gap-x-1.5 text-sm"
            :class="task.overdue ? 'text-error' : 'text-muted'"
          >
            <UIcon
              :name="
                task.overdue ? 'i-lucide-calendar-x' : 'i-lucide-calendar-clock'
              "
              class="size-4 shrink-0"
              aria-hidden="true"
            />
            <template v-if="task.overdue">
              {{ t("home.work.overdue", { date: dueDate(task) }) }}
            </template>
            <template v-else>
              <span>{{ t("home.work.due", { date: dueDate(task) }) }}</span>
              <CommonCountdown :to="task.dueAt" :urgent-hours="72" />
            </template>
          </p>
        </div>
      </div>
      <UButton
        :to="localePath(homeTaskPath(task))"
        :label="t(`home.work.tasks.${task.kind}.action`)"
        :color="primary && index === 0 ? 'primary' : 'neutral'"
        :variant="primary && index === 0 ? 'solid' : 'outline'"
        size="sm"
        trailing-icon="i-lucide-arrow-right"
        class="shrink-0 self-start"
        :class="compact ? 'ms-11' : 'ms-11 sm:ms-0'"
        :aria-label="
          t('home.work.actionFor', {
            action: t(`home.work.tasks.${task.kind}.action`),
            item: title(task),
          })
        "
      />
    </li>
  </ul>
</template>
