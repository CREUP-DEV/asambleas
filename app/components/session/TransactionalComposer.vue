<script setup lang="ts">
import { createId } from "@paralleldrive/cuid2";
import type { AmendmentDto } from "~~/shared/types/api";
import type { Block } from "~~/shared/types/content";
import { diffPassage } from "~~/shared/utils/content/diff";
import { validateOps } from "~~/shared/utils/content/ops";
import {
  sameBlockContent,
  sameIdSet,
  transactionalSeed,
  type TransactionalSeed,
} from "~~/shared/utils/content/transactionalSeed";
import {
  isSessionDecidable,
  isSessionOpen,
  isSessionPendingAdmission,
  sessionTransactionalParties,
} from "~/composables/session/sessionModel";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";
import { widenedEdit } from "~/composables/amendment/transactional";
import {
  isTransactionalComposerCopy,
  sameIdList,
  type TransactionalComposerCopy,
} from "~/composables/amendment/draftCopy";
import { useDraftCopy } from "~/composables/amendment/useDraftCopy";

/**
 * Builds a transactional amendment in the room. The editor starts from the
 * passage its sources touch, with the sources applied in order of
 * presentation (when two collide, the first that applies wins). The diff
 * against the base updates as the Mesa types. It is presented by the main
 * authors of its sources unless the Mesa picks others, and with several
 * authors one of them is its main author. Once created it is validated and
 * published at once; the answer the main author of each source gives in
 * the room is recorded in the acceptance list, and when they all accept it
 * replaces those amendments.
 *
 * The text typed live is never thrown away silently: closing the panel
 * (Escape, the overlay, the close button) keeps the draft, and reopening it
 * for the same amendments resumes it. Changing the sources, resetting the
 * text, cancelling, starting a transactional for other amendments or leaving
 * the page all ask before discarding what was typed.
 *
 * The console follows the document in debate, which another Mesa member can
 * move. A draft belongs to the document it was started on: while the console
 * shows another one the panel names that document instead of the form, the
 * draft is kept, and it comes back when the console returns to it. Starting
 * a transactional on the new document asks first, naming the old one.
 *
 * Until it is created, this browser keeps a copy of the draft per document
 * (`useDraftCopy`): after a reload or a crash, opening the panel on that
 * document offers «Recuperar» once.
 */
const session = useSessionConsoleContext();
const { t } = useI18n();

const open = computed({
  get: () => session.composer.open,
  set: (value: boolean) => {
    session.composer.open = value;
  },
});

const sourceIds = ref<string[]>([]);
const edited = ref<Block[]>([]);
const justification = ref("");
const authorIds = ref<string[]>([]);
/** The Mesa chose the authors by hand: a reseed keeps its choice. */
const authorsTouched = ref(false);
/** Main author among the authors (required when there are several). */
const mainAuthorId = ref<string | null>(null);
const createdId = ref<string | null>(null);
const seed = shallowRef<TransactionalSeed | null>(null);
const editorKey = ref(0);
/**
 * Paragraphs taken in around what the amendments touch (user's decision of
 * 2026-11-20), as in the members' composer.
 */
const widen = ref({ before: 0, after: 0 });
const editor = useTemplateRef<{ flush: () => void }>("editor");
/** Set when the Mesa discards the draft: the next opening starts afresh. */
let discarded = false;
/**
 * A draft just started whose copy in this browser has not been read yet:
 * nothing is written over it until it is (`copyReady`, `offerCopy`).
 */
let copyUnread = false;
/** The document the draft was started on: it only applies to that base. */
const draftDocumentId = ref<string | null>(null);
/** Its title, kept to name it once the console shows another document. */
const draftDocumentTitle = ref("");
/**
 * Its base version: the local copy only fits that one. Undefined until the
 * console has read that document (`session.document` and the amendments are
 * separate reads, so the amendments may arrive first).
 */
const draftBaseVersionId = ref<string | null | undefined>(undefined);

/** The draft was started on a document the console no longer shows. */
const onOtherDocument = computed(
  () =>
    seed.value !== null && draftDocumentId.value !== session.documentId.value,
);

function documentTitle(id: string | null): string {
  if (!id) return "";
  if (session.document.value?.id === id) return session.document.value.title;
  for (const row of session.agendaRows.value) {
    const document = row.documents.find((candidate) => candidate.id === id);
    if (document) return document.title;
  }
  return "";
}

const eligible = computed(() =>
  session.amendments.value.filter(
    (amendment) =>
      isSessionOpen(amendment) ||
      isSessionPendingAdmission(amendment) ||
      sourceIds.value.includes(amendment.id),
  ),
);
const sourceItems = computed(() =>
  eligible.value.map((amendment) => ({
    label: `${session.label(amendment.id)} · ${amendment.authors
      .map((author) => author.acronym)
      .join(", ")}`,
    // Late and awaiting the assembly: it goes in only if admitted.
    description: isSessionPendingAdmission(amendment)
      ? t("transactional.composer.lateSource")
      : undefined,
    value: amendment.id,
  })),
);

/** Amendments by id in order of presentation: the first one wins a collision. */
function sourcesOf(ids: string[]): AmendmentDto[] {
  return ids
    .map((id) => session.byId.value.get(id))
    .filter((amendment) => amendment !== undefined)
    .sort(
      (a, b) =>
        (a.number ?? Number.MAX_SAFE_INTEGER) -
          (b.number ?? Number.MAX_SAFE_INTEGER) ||
        a.positionKey - b.positionKey,
    );
}

/** Sources in order of presentation: the first one wins a collision. */
const sources = computed<AmendmentDto[]>(() => sourcesOf(sourceIds.value));

/** The main author of each source: who has to accept it. */
/** Who accepts it: the originals' main authors (2026-11-20). */
const parties = computed(() =>
  sessionTransactionalParties(sources.value, session.byId.value),
);
/**
 * Who may sign it: those parties and the main authors of what it combines
 * directly (a transactional's own author included), as the server allows.
 */
const partyItems = computed(() => {
  const seen = new Map<string, ReturnType<typeof memberMenuItem>>();
  for (const party of [
    ...parties.value,
    ...sessionTransactionalParties(sources.value),
  ]) {
    if (!seen.has(party.member.id)) {
      seen.set(party.member.id, memberMenuItem(party.member));
    }
  }
  return [...seen.values()];
});
/** The authors chosen, as the main author select lists them. */
const mainAuthorItems = computed(() =>
  partyItems.value.filter((item) => authorIds.value.includes(item.value)),
);

// The main author is always one of the authors: the first by default.
watch(
  authorIds,
  (ids) => {
    if (!mainAuthorId.value || !ids.includes(mainAuthorId.value)) {
      mainAuthorId.value = ids[0] ?? null;
    }
  },
  { immediate: true },
);

/** What the seed applies: the chosen amendments. */
function seedSources() {
  return sources.value.map((amendment) => ({
    id: amendment.id,
    ops: amendment.ops,
  }));
}

/** Whether there is text before or after the passage to take in. */
const passageEdges = computed(() => {
  const passage = seed.value?.passage ?? [];
  const base = session.base.value;
  if (passage.length === 0) return { first: true, last: true };
  const index = base.findIndex((block) => block.id === passage[0]!.id);
  return {
    first: index <= 0,
    last: index + passage.length >= base.length,
  };
});

/** Takes in the paragraph before or after, keeping what was written. */
function widenPassage(side: "before" | "after"): void {
  editor.value?.flush();
  const previous = seed.value;
  if (!previous) return;
  const next = { ...widen.value, [side]: widen.value[side] + 1 };
  const wider = transactionalSeed(
    session.base.value,
    seedSources(),
    createId,
    next,
  );
  const kept = widenedEdit(previous, wider, edited.value);
  if (!kept) return;
  widen.value = next;
  seed.value = wider;
  edited.value = kept;
  editorKey.value += 1;
}

/** Restarts the text from the current sources (the editor is remounted). */
function reseed(): void {
  seed.value = transactionalSeed(
    session.base.value,
    seedSources(),
    createId,
    widen.value,
  );
  edited.value = seed.value.seed.map((block) => ({
    ...block,
    marks: [...block.marks],
  }));
  editorKey.value += 1;
  const partyIds = new Set(parties.value.map((party) => party.member.id));
  authorIds.value = authorsTouched.value
    ? authorIds.value.filter((id) => partyIds.has(id))
    : parties.value.map((party) => party.member.id);
}

function startFresh(ids: string[]): void {
  discarded = false;
  resumeCopy();
  draftDocumentId.value = session.documentId.value;
  draftDocumentTitle.value = documentTitle(draftDocumentId.value);
  draftBaseVersionId.value = undefined;
  fillDraftBase();
  createdId.value = null;
  justification.value = "";
  authorsTouched.value = false;
  mainAuthorId.value = null;
  sourceIds.value = [...ids];
  reseed();
}

/** Whether the text differs from the seed. Flushes the editor first. */
function textEdited(): boolean {
  // The editor emits with a short delay: take what is on screen right now.
  editor.value?.flush();
  return (
    seed.value !== null && !sameBlockContent(edited.value, seed.value.seed)
  );
}

/**
 * A draft not created yet that holds something the Mesa typed or chose,
 * on whichever document it was started: the console moving to another one
 * does not make it any less worth keeping. With the editor unmounted, the
 * text is the one it emitted when it was removed.
 */
function hasDraft(): boolean {
  if (discarded || createdId.value || !seed.value) return false;
  return (
    textEdited() || justification.value.trim() !== "" || authorsTouched.value
  );
}

/** The question before discarding the draft, naming its document if hidden. */
function discardMessage(): string {
  return onOtherDocument.value
    ? t("session.composer.discardOtherConfirm", {
        title: draftDocumentTitle.value,
      })
    : t("session.composer.discardConfirm");
}

watch(open, (isOpen) => {
  if (!isOpen) return;
  const requested = [...session.composer.sourceIds];
  /** A draft the Mesa confirmed to drop: its copy goes with it. */
  let replacing = false;
  if (!discarded && !createdId.value && seed.value) {
    if (onOtherDocument.value) {
      // A draft left on another document: it cannot continue here, and it
      // is kept for when the console returns there unless the Mesa drops it.
      replacing = hasDraft();
      if (
        replacing &&
        !window.confirm(
          t("session.composer.replaceOtherConfirm", {
            title: draftDocumentTitle.value,
          }),
        )
      ) {
        open.value = false;
        return;
      }
    } else {
      // Reopened for the same amendments: resume the draft as it was.
      if (sameIdSet(requested, sourceIds.value)) return;
      // Opened for other amendments: keep the draft unless the Mesa drops it.
      replacing = hasDraft();
      if (replacing && !window.confirm(t("session.composer.replaceConfirm"))) {
        return;
      }
    }
  }
  // Still under the old draft's key: never offered back once dropped.
  if (replacing) discardCopy();
  startFresh(requested);
  // A draft kept in this browser for this document: offered once, as soon
  // as the document and its amendments are read (`copyReady`).
  copyUnread = true;
  offerCopy();
});

// Another Mesa member moved the console to another document. With nothing
// to keep, the panel (about the old document's amendments) just closes.
// With a draft, it stays open and names the document the draft belongs to.
watch(
  () => session.documentId.value,
  () => {
    if (open.value && !hasDraft()) open.value = false;
  },
);

// The notice replaces the form, editor included, possibly under the caret:
// move focus to it so a keyboard or screen-reader user learns why the text
// field went away and where the draft is, instead of landing on the panel.
const otherAlert = useTemplateRef<{ $el?: HTMLElement }>("otherAlert");
watch(onOtherDocument, (other) => {
  if (!other) return;
  void nextTick(() => {
    if (open.value && onOtherDocument.value) otherAlert.value?.$el?.focus?.();
  });
});

function onSourcesChange(value: string[] | null | undefined): void {
  const next = [...(value ?? [])];
  if (sameIdSet(next, sourceIds.value)) {
    sourceIds.value = next;
    return;
  }
  // Cancelling leaves the selection as it was: the menu is controlled.
  if (textEdited() && !window.confirm(t("session.composer.reseedConfirm"))) {
    return;
  }
  sourceIds.value = next;
  widen.value = { before: 0, after: 0 };
  reseed();
}

function onAuthorsChange(value: string[] | null | undefined): void {
  authorIds.value = [...(value ?? [])];
  authorsTouched.value = true;
}

function resetText(): void {
  if (textEdited() && !window.confirm(t("session.composer.resetConfirm"))) {
    return;
  }
  widen.value = { before: 0, after: 0 };
  reseed();
}

/** The footer button: discards the draft, after asking if there is one. */
function cancel(close: () => void): void {
  if (hasDraft()) {
    if (!window.confirm(discardMessage())) return;
    discarded = true;
    discardCopy();
  }
  close();
}

// A confirmed leave gives the draft up, copy included; a reload keeps it.
useLeaveGuard(hasDraft, discardMessage, () => discardCopy());

// The copy in this browser ---------------------------------------------------------

/**
 * What the copy keeps now; null when nothing would be lost. Like hasDraft,
 * but it never flushes the editor: it runs on every change.
 */
function copySnapshot(): TransactionalComposerCopy | null {
  const current = seed.value;
  if (discarded || createdId.value || !current) return null;
  const textChanged = !sameBlockContent(edited.value, current.seed);
  if (!textChanged && !justification.value.trim() && !authorsTouched.value) {
    return null;
  }
  return {
    sourceIds: [...sourceIds.value],
    widen: { ...widen.value },
    passageIds: current.passage.map((block) => block.id),
    edited: edited.value,
    justification: justification.value,
    authorIds: [...authorIds.value],
    authorsTouched: authorsTouched.value,
    executiveAuthorIds: [],
    mainAuthorId: mainAuthorId.value,
  };
}

/**
 * A copy fits while its amendments are still open in the room and they
 * still give the passage it was written over.
 */
function copyFits(data: unknown): data is TransactionalComposerCopy {
  if (!isTransactionalComposerCopy(data) || data.sourceIds.length === 0) {
    return false;
  }
  const kept = sourcesOf(data.sourceIds);
  if (
    kept.length !== data.sourceIds.length ||
    kept.some(
      (amendment) =>
        !isSessionOpen(amendment) && !isSessionPendingAdmission(amendment),
    )
  ) {
    return false;
  }
  try {
    const again = transactionalSeed(
      session.base.value,
      kept.map(({ id, ops }) => ({ id, ops })),
      createId,
      data.widen,
    );
    return sameIdList(
      again.passage.map((block) => block.id),
      data.passageIds,
    );
  } catch {
    return false;
  }
}

/** The draft's base, read once the console has its document. */
function fillDraftBase(): void {
  if (draftBaseVersionId.value !== undefined || !draftDocumentId.value) return;
  const current = session.document.value;
  if (current?.id === draftDocumentId.value) {
    draftBaseVersionId.value = current.baseVersion?.id ?? null;
  }
}

/**
 * Whether the copy can be read and written: its base is known and, until
 * the copy has been read, the console holds the draft's document and its
 * amendments (`copyFits` checks them; against data still loading a good
 * copy would be dropped). Once read, writing goes on while the console
 * shows another document: the draft stays on its own.
 */
function copyReady(): boolean {
  if (draftBaseVersionId.value === undefined) return false;
  if (!copyUnread) return true;
  return (
    session.document.value?.id === draftDocumentId.value &&
    session.amendments.value.length > 0
  );
}

/**
 * Reads the copy of the draft just started, once it can be: offered unless
 * the Mesa already typed something, which is the draft now and overwrites it.
 */
function offerCopy(): void {
  if (!copyUnread) return;
  fillDraftBase();
  if (!copyReady()) return;
  copyUnread = false;
  if (copySnapshot() === null) openCopy();
  else flushCopy();
}

watch(
  () =>
    [
      session.document.value?.id,
      session.document.value?.baseVersion?.id,
      session.amendments.value.length,
    ] as const,
  () => {
    fillDraftBase();
    offerCopy();
  },
);

const {
  offer: copyOffer,
  open: openCopy,
  recover: takeCopy,
  discard: discardCopy,
  resume: resumeCopy,
  dismiss: dismissCopy,
  flush: flushCopy,
} = useDraftCopy<TransactionalComposerCopy>({
  composer: "session-transactional",
  documentId: () => draftDocumentId.value,
  scope: () => "new",
  stamp: () => ({
    baseVersionId: draftBaseVersionId.value ?? null,
    token: null,
  }),
  ready: copyReady,
  snapshot: copySnapshot,
  track: [
    sourceIds,
    edited,
    justification,
    authorIds,
    mainAuthorId,
    widen,
    createdId,
  ],
  settle: () => editor.value?.flush(),
  accept: copyFits,
});

/** Puts the kept draft back: its amendments, passage, text and authors. */
function recoverCopy(): void {
  const data = takeCopy();
  if (!data) return;
  sourceIds.value = [...data.sourceIds];
  widen.value = { ...data.widen };
  authorsTouched.value = data.authorsTouched;
  if (data.authorsTouched) authorIds.value = [...data.authorIds];
  // The editor is mounted again (reseed) with the kept text in it, a fresh
  // copy read from storage.
  reseed();
  edited.value = data.edited;
  justification.value = data.justification;
  mainAuthorId.value = data.mainAuthorId;
}

const ops = computed(() =>
  seed.value && seed.value.passage.length > 0
    ? diffPassage(
        seed.value.passage,
        edited.value,
        seed.value.anchorBefore,
        createId,
        seed.value.before,
      )
    : [],
);
const opErrors = computed(() => validateOps(session.base.value, ops.value));
const skipped = computed(() => seed.value?.skipped ?? []);

const created = computed(() =>
  createdId.value ? (session.byId.value.get(createdId.value) ?? null) : null,
);
// Never while the draft belongs to another document: right after the console
// switches, the new document's data may still hold the old one's, so the
// sources and the checks below would wrongly pass against the wrong URL.
const canCreate = computed(
  () =>
    !onOtherDocument.value &&
    !createdId.value &&
    sources.value.length > 0 &&
    ops.value.length > 0 &&
    opErrors.value.length === 0,
);

async function create(): Promise<void> {
  editor.value?.flush();
  await nextTick();
  if (!canCreate.value) return;
  const result = await session.createTransactional({
    sourceIds: sources.value.map((amendment) => amendment.id),
    ops: ops.value,
    justification: justification.value.trim(),
    authorMemberIds: authorIds.value,
    mainAuthorMemberId:
      mainAuthorId.value && authorIds.value.includes(mainAuthorId.value)
        ? mainAuthorId.value
        : (authorIds.value[0] ?? null),
    submit: true,
  });
  if (result) {
    createdId.value = result.id;
    discardCopy();
  }
}

function debateCreated(): void {
  if (created.value) void session.requestDebate(created.value);
}

function voteCreated(): void {
  if (!created.value) return;
  const target = created.value;
  open.value = false;
  session.openVote(target);
}
</script>

<template>
  <USlideover
    v-model:open="open"
    side="right"
    :title="
      created
        ? t('session.composer.createdTitle', { code: created.code ?? '' })
        : t('session.composer.title')
    "
    :description="t('session.composer.description')"
    :ui="{ content: 'w-full max-w-4xl' }"
  >
    <template #body>
      <UAlert
        v-if="onOtherDocument"
        ref="otherAlert"
        role="alert"
        tabindex="-1"
        color="warning"
        variant="subtle"
        icon="i-lucide-file-clock"
        class="outline-none focus-visible:ring-2 focus-visible:ring-primary"
        :title="t('session.composer.otherDocumentTitle')"
        :description="
          t('session.composer.otherDocument', { title: draftDocumentTitle })
        "
      />
      <div v-else-if="!created" class="space-y-6">
        <!-- A draft this browser kept for this document: offered once. -->
        <AmendmentDraftCopyNotice
          v-if="copyOffer"
          :saved-at="copyOffer.savedAt"
          @recover="recoverCopy"
          @discard="dismissCopy"
        />
        <UFormField
          :label="t('session.composer.sources')"
          :hint="t('session.composer.sourcesHint')"
          name="composer-sources"
          required
        >
          <USelectMenu
            :model-value="sourceIds"
            :items="sourceItems"
            value-key="value"
            multiple
            :placeholder="t('session.composer.sourcesPlaceholder')"
            :aria-label="
              selectMenuLabel(
                t('session.composer.sources'),
                sourceItems,
                sourceIds,
                t('session.composer.sourcesPlaceholder'),
              )
            "
            :search-input="labelledSearch(t('common.search'))"
            class="w-full"
            @update:model-value="onSourcesChange"
          />
        </UFormField>

        <UAlert
          v-if="skipped.length > 0"
          color="warning"
          variant="subtle"
          icon="i-lucide-git-compare"
          :title="t('session.composer.skippedTitle')"
          :description="
            t('session.composer.skipped', {
              codes: skipped.map(session.label).join(', '),
            })
          "
        />

        <CommonEmptyState
          v-if="sources.length === 0"
          icon="i-lucide-git-merge"
          size="sm"
          :title="t('session.composer.noSources')"
        />
        <CommonEmptyState
          v-else-if="!seed || seed.passage.length === 0"
          icon="i-lucide-file-question"
          size="sm"
          :title="t('session.composer.noPassage')"
        />
        <div v-else class="grid gap-4 xl:grid-cols-2">
          <section class="min-w-0 space-y-2">
            <h3 class="text-highlighted text-sm font-medium">
              {{ t("session.composer.text") }}
            </h3>
            <UButton
              v-if="!passageEdges.first"
              icon="i-lucide-arrow-up-to-line"
              color="neutral"
              variant="ghost"
              size="xs"
              :label="t('transactional.composer.widenBefore')"
              @click="widenPassage('before')"
            />
            <ClientOnly>
              <ContentBlockEditor
                :key="editorKey"
                ref="editor"
                v-model="edited"
                :label="t('session.composer.text')"
                autofocus
              />
              <template #fallback>
                <USkeleton aria-hidden="true" class="h-48 w-full" />
              </template>
            </ClientOnly>
            <div class="flex flex-wrap gap-2">
              <UButton
                v-if="!passageEdges.last"
                icon="i-lucide-arrow-down-to-line"
                color="neutral"
                variant="ghost"
                size="xs"
                :label="t('transactional.composer.widenAfter')"
                @click="widenPassage('after')"
              />
              <UButton
                icon="i-lucide-rotate-ccw"
                color="neutral"
                variant="ghost"
                size="sm"
                :label="t('session.composer.reset')"
                @click="resetText"
              />
            </div>
          </section>
          <section class="min-w-0 space-y-2" aria-live="polite">
            <h3 class="text-highlighted text-sm font-medium">
              {{ t("session.composer.diff") }}
            </h3>
            <p v-if="ops.length === 0" class="text-muted text-sm">
              {{ t("session.composer.noChanges") }}
            </p>
            <ContentAmendmentDiff
              v-else
              id="transactional-draft"
              :base="session.base.value"
              :ops="ops"
            />
          </section>
        </div>

        <UFormField
          :label="t('session.composer.justification')"
          name="composer-justification"
        >
          <UTextarea
            v-model="justification"
            :rows="3"
            autoresize
            :maxlength="20000"
            class="content-font w-full"
          />
        </UFormField>

        <UFormField
          :label="t('session.composer.authors')"
          :hint="t('session.composer.authorsHint')"
          name="composer-authors"
        >
          <USelectMenu
            :model-value="authorIds"
            :items="partyItems"
            value-key="value"
            :ui="MEMBER_MENU_UI"
            :filter-fields="MEMBER_MENU_FILTER_FIELDS"
            multiple
            :placeholder="t('session.composer.authorsPlaceholder')"
            :aria-label="
              selectMenuLabel(
                t('session.composer.authors'),
                partyItems,
                authorIds,
                t('session.composer.authorsPlaceholder'),
              )
            "
            :search-input="labelledSearch(t('common.search'))"
            class="w-full"
            @update:model-value="onAuthorsChange"
          />
        </UFormField>

        <UFormField
          v-if="authorIds.length > 1"
          :label="t('session.composer.mainAuthor')"
          :hint="t('session.composer.mainAuthorHint')"
          name="composer-main-author"
          required
        >
          <USelect
            :model-value="mainAuthorId ?? undefined"
            :items="mainAuthorItems"
            value-key="value"
            class="w-full"
            @update:model-value="mainAuthorId = $event ?? null"
          />
        </UFormField>

        <section v-if="parties.length > 0" class="space-y-2">
          <h3 class="text-highlighted text-sm font-medium">
            {{ t("session.composer.parties") }}
          </h3>
          <p class="text-muted text-sm">
            {{ t("session.composer.partiesHint") }}
          </p>
          <ul class="flex flex-wrap gap-2">
            <li
              v-for="party in parties"
              :key="party.member.id"
              class="inline-flex items-center gap-1"
            >
              <CommonMemberBadge :member="party.member" />
              <span class="text-muted text-xs">
                {{
                  t("session.acceptance.mainAuthorOf", {
                    codes: party.sourceIds.map(session.label).join(", "),
                  })
                }}
              </span>
            </li>
          </ul>
        </section>
      </div>

      <div v-else class="space-y-6">
        <UAlert
          color="success"
          variant="subtle"
          icon="i-lucide-git-merge"
          :title="t('session.composer.created', { code: created.code ?? '' })"
          :description="t('session.composer.createdHint')"
        />
        <SessionAcceptanceList :amendment="created" />
        <section class="space-y-2">
          <h3 class="text-highlighted text-sm font-medium">
            {{ t("session.composer.diff") }}
          </h3>
          <ContentAmendmentDiff
            :id="created.id"
            :base="session.base.value"
            :ops="created.ops"
          />
        </section>
      </div>
    </template>

    <template #footer="{ close }">
      <div class="flex w-full flex-wrap justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :label="created ? t('common.close') : t('common.cancel')"
          @click="cancel(close)"
        />
        <template v-if="created">
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-radio"
            :label="t('session.actions.debate')"
            @click="debateCreated"
          />
          <UButton
            icon="i-lucide-gavel"
            :label="t('session.actions.vote')"
            :disabled="!isSessionDecidable(created)"
            @click="voteCreated"
          />
        </template>
        <UButton
          v-else
          icon="i-lucide-git-merge"
          :label="t('session.composer.submit')"
          :loading="Boolean(session.busy.value.transactional)"
          :disabled="!canCreate"
          @click="create"
        />
      </div>
    </template>
  </USlideover>
</template>
