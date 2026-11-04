<script setup lang="ts">
import { DOCUMENT_KIND_DEFAULTS } from "~~/shared/constants/domain";
import type { AssemblyDto, DocumentDto } from "~~/shared/types/api";
import { formatDateTime, toDate } from "~/utils/format";

/**
 * Confirmation of "Presentar" (a member submits the draft for admission) or
 * "Publicar" (Secretaría publishes it and freezes the text), with a
 * checklist of what will happen and what is missing. Blocking items disable
 * the confirm button. The parent performs the request on `confirm`.
 *
 * Publishing again a withdrawn or postponed document (`publishedAt` set)
 * keeps its base text, reference and amendments; the copy says so and the
 * text check counts the frozen base instead of the working draft.
 */
const props = withDefaults(
  defineProps<{
    mode: "submit" | "publish";
    document: DocumentDto;
    assembly: AssemblyDto;
    /**
     * Blocks of the draft as it will be saved (structured documents). Ignored
     * once the text is frozen: the base version is counted instead.
     */
    blockCount: number;
    /** The text has changes that will be saved first. */
    textDirty?: boolean;
    /** The metadata form has unsaved changes (blocking). */
    metadataDirty?: boolean;
    /** The actor holds document:manage (not bound by the deadline). */
    manager?: boolean;
    busy?: boolean;
  }>(),
  { textDirty: false, metadataDirty: false, manager: false, busy: false },
);

const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{ confirm: [] }>();

const { t, locale } = useI18n();

type CheckState = "ok" | "warning" | "error" | "info";

interface Check {
  key: string;
  state: CheckState;
  title: string;
  description?: string;
}

const CHECK_ICONS: Record<CheckState, string> = {
  ok: "i-lucide-circle-check",
  warning: "i-lucide-triangle-alert",
  error: "i-lucide-circle-x",
  info: "i-lucide-info",
};

const CHECK_COLORS: Record<CheckState, string> = {
  ok: "text-success",
  warning: "text-warning",
  error: "text-error",
  info: "text-info",
};

function date(value: string | Date | null | undefined): string {
  return formatDateTime(value, { locale: locale.value });
}

function milestone(key: string): string | null {
  return props.assembly.milestones.find((m) => m.key === key)?.at ?? null;
}

const isFile = computed(() => props.document.format === "file");

/** Publishing again a document that was already published. */
const republish = computed(
  () => props.mode === "publish" && props.document.publishedAt !== null,
);

const textBlocks = computed(() =>
  props.document.baseVersion
    ? props.document.baseVersion.blocks.length
    : props.blockCount,
);

const contentCheck = computed<Check>(() => {
  if (isFile.value) {
    return props.document.fileUrl
      ? {
          key: "content",
          state: "ok",
          title: t("document.publish.checks.fileReady", {
            name: props.document.fileName ?? "PDF",
          }),
        }
      : {
          key: "content",
          state: "error",
          title: t("document.publish.checks.fileMissing"),
        };
  }
  return textBlocks.value > 0
    ? {
        key: "content",
        state: "ok",
        title: t(
          "document.publish.checks.textReady",
          { count: textBlocks.value },
          textBlocks.value,
        ),
      }
    : {
        key: "content",
        state: "error",
        title: t("document.publish.checks.textEmpty"),
      };
});

const deadlineCheck = computed<Check>(() => {
  const close = milestone("documents_close");
  const closeDate = toDate(close);
  if (!closeDate) {
    return {
      key: "deadline",
      state: "info",
      title: t("document.publish.checks.noDeadline"),
    };
  }
  if (closeDate.getTime() < Date.now()) {
    return {
      key: "deadline",
      state: props.manager ? "warning" : "error",
      title: t("document.publish.checks.deadlinePassed", { date: date(close) }),
      description: props.manager
        ? t("document.publish.checks.deadlineManager")
        : undefined,
    };
  }
  return {
    key: "deadline",
    state: "ok",
    title: t("document.publish.checks.deadlineOpen", { date: date(close) }),
  };
});

const windowCheck = computed<Check>(() => {
  if (isFile.value || !props.document.amendable) {
    return {
      key: "window",
      state: "info",
      title: t("document.publish.checks.notAmendable"),
    };
  }
  const { opensAt, closesAt } = props.document.window;
  const override =
    props.document.amendmentsOpenAt !== null ||
    props.document.amendmentsCloseAt !== null;
  const source = override
    ? t("document.publish.checks.windowOverride")
    : t("document.publish.checks.windowCalendar");
  const closes = toDate(closesAt);
  const opens = toDate(opensAt);
  const now = Date.now();

  if (!closes) {
    return {
      key: "window",
      state: "warning",
      title: t("document.publish.checks.windowNoClose"),
      description: source,
    };
  }
  if (closes.getTime() <= now) {
    return {
      key: "window",
      state: "warning",
      title: t("document.publish.checks.windowPast", { date: date(closesAt) }),
      description: source,
    };
  }
  return {
    key: "window",
    state: "ok",
    title:
      opens && opens.getTime() > now
        ? t("document.publish.checks.windowRange", {
            opens: date(opensAt),
            closes: date(closesAt),
          })
        : t("document.publish.checks.windowFromPublication", {
            closes: date(closesAt),
          }),
    description: source,
  };
});

const referenceCheck = computed<Check>(() => {
  if (props.document.reference) {
    return {
      key: "reference",
      state: "info",
      title: t("document.publish.checks.referenceKeep", {
        reference: props.document.reference,
      }),
    };
  }
  const prefix = DOCUMENT_KIND_DEFAULTS[props.document.kind].referencePrefix;
  if (!prefix) {
    return {
      key: "reference",
      state: "info",
      title: t("document.publish.checks.referenceNone"),
    };
  }
  const year = new Intl.DateTimeFormat("en", {
    timeZone: "Europe/Madrid",
    year: "numeric",
  }).format(new Date());
  return {
    key: "reference",
    state: "info",
    title: t("document.publish.checks.referenceAssign", { prefix, year }),
  };
});

const checks = computed<Check[]>(() => {
  const list: Check[] = [contentCheck.value];

  if (!isFile.value && props.textDirty && !props.document.baseVersion) {
    list.push({
      key: "unsaved",
      state: "info",
      title: t("document.publish.checks.textUnsaved"),
    });
  }
  if (props.metadataDirty) {
    list.push({
      key: "metadata",
      state: "error",
      title: t("document.publish.checks.metadataUnsaved"),
    });
  }

  if (props.mode === "submit") {
    list.push(deadlineCheck.value);
    return list;
  }

  if (!props.document.proponent) {
    list.push({
      key: "proponent",
      state: "warning",
      title: t("document.publish.checks.noProponent"),
    });
  }
  list.push(windowCheck.value, referenceCheck.value);

  const scheduled = milestone("documents_publish");
  if (scheduled) {
    list.push({
      key: "scheduled",
      state: "info",
      title: t("document.publish.checks.scheduled", { date: date(scheduled) }),
    });
  }
  if (props.assembly.status === "draft") {
    list.push({
      key: "assemblyDraft",
      state: "warning",
      title: t("document.publish.checks.assemblyDraft"),
    });
  }
  return list;
});

const blocked = computed(() =>
  checks.value.some((check) => check.state === "error"),
);

const copy = computed(() => {
  if (props.mode === "submit") {
    return {
      title: t("document.submit.title"),
      description: t("document.submit.description"),
      confirm: t("document.submit.confirm"),
      icon: "i-lucide-send",
    };
  }
  if (republish.value) {
    return {
      title: t("document.republish.title"),
      description: t("document.republish.description"),
      confirm: t("document.republish.confirm"),
      icon: "i-lucide-rotate-ccw",
    };
  }
  return {
    title: t("document.publish.title"),
    description: isFile.value
      ? t("document.publish.descriptionFile")
      : t("document.publish.description"),
    confirm: t("document.publish.confirm"),
    icon: "i-lucide-megaphone",
  };
});
</script>

<template>
  <UModal
    v-model:open="open"
    :title="copy.title"
    :description="copy.description"
    :dismissible="!busy"
    :ui="{ footer: 'justify-end gap-2' }"
  >
    <template #body>
      <h3 class="text-highlighted mb-2 text-sm font-semibold">
        {{ t("document.publish.checklist") }}
      </h3>
      <ul class="space-y-3">
        <li
          v-for="check in checks"
          :key="check.key"
          class="flex items-start gap-2.5"
          :data-check="check.key"
          :data-state="check.state"
        >
          <UIcon
            :name="CHECK_ICONS[check.state]"
            class="mt-0.5 size-5 shrink-0"
            :class="CHECK_COLORS[check.state]"
            aria-hidden="true"
          />
          <div class="min-w-0 text-sm">
            <span class="sr-only">
              {{ t(`document.publish.states.${check.state}`) }}:
            </span>
            <p class="text-default">{{ check.title }}</p>
            <p v-if="check.description" class="text-muted text-xs">
              {{ check.description }}
            </p>
          </div>
        </li>
      </ul>
      <p
        v-if="blocked"
        class="text-error mt-4 text-sm"
        role="status"
        aria-live="polite"
      >
        {{ t("document.publish.blocked") }}
      </p>
    </template>

    <template #footer="{ close }">
      <UButton
        color="neutral"
        variant="ghost"
        :label="t('document.publish.cancel')"
        :disabled="busy"
        @click="close"
      />
      <UButton
        :icon="copy.icon"
        :label="copy.confirm"
        :loading="busy"
        :disabled="blocked || busy"
        @click="emit('confirm')"
      />
    </template>
  </UModal>
</template>
