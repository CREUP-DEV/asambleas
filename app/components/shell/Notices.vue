<script setup lang="ts">
import { homeWorkNews } from "~/components/home/-work";
import { moderates, reviewsAmendments } from "~~/shared/utils/permissionRules";
import {
  noticesAnnouncement,
  splitNotices,
} from "~/composables/shell/-notices";

/**
 * «Avisos»: what others decided about the user's documents and amendments,
 * and, for the Mesa (session:moderate), the latest about the assemblies'
 * amendments, in a panel that opens over any page (the sidebar's entry,
 * ShellNavigation), so it never takes the user away from where they are. It
 * comes in from the left, the side of the sidebar and of the phone's drawer
 * it is opened from (user's decision of 2026-11-26): on a phone the drawer
 * closes and the panel takes its place, never the other edge.
 * «Nuevos» are the notices later than the mark the account had when the
 * panel opened, «Anteriores» the rest; each row is a link (HomeNewsList),
 * and following one closes the panel. Opening it marks them seen
 * (useNotices). No other button.
 *
 * Mounted once, client only, by the default layout. It also reads the
 * notices: once mounted, on a route change and when the tab is shown
 * again, at most every 30 s (useNotices). When the number of new notices
 * rises while the page is open, one polite line says so to screen readers,
 * never on the first read nor while the panel is open (the new row is in
 * it, and marked seen); no toast says it. The line empties when the count
 * falls, so it never keeps a number that is no longer true.
 */
const { t } = useI18n();
const route = useRoute();
const { can, member } = useMe();
/**
 * The texts say what the account is told, by the server's scope
 * (mesaNewsScope): the Mesa's notices too (session:moderate), with the
 * Secretaría's validations unless it validates amendments itself, and the
 * member's own only with a member.
 */
const mesa = computed(() => moderates(can));
const description = computed(() => {
  if (!mesa.value) return t("shell.notices.description");
  return t(
    member.value
      ? "shell.notices.descriptionMesa"
      : "shell.notices.descriptionMesaNoMember",
  );
});
const emptyDescription = computed(() => {
  if (!mesa.value) return t("shell.notices.emptyDescription");
  const lead = t(
    reviewsAmendments(can)
      ? "shell.notices.emptyDescriptionMesa"
      : "shell.notices.emptyDescriptionMesaValidated",
  );
  return member.value
    ? `${lead} ${t("shell.notices.emptyDescriptionMesaMember")}`
    : lead;
});
const {
  data,
  failed,
  unread,
  open,
  panelSeenAt,
  refreshThrottled,
  closePanel,
  retry,
  dispose,
} = useNotices();

const news = computed(() =>
  data.value ? homeWorkNews([...data.value.items]) : [],
);
const lists = computed(() => splitNotices(news.value, panelSeenAt.value));

const announcement = ref("");
// Emptied first and set on the next tick, so every rise changes the live
// region's text, even to a number it said before.
let announcing = 0;
watch(unread, async (next, previous) => {
  const turn = ++announcing;
  announcement.value = "";
  const count = open.value ? null : noticesAnnouncement(previous, next);
  if (count === null) return;
  await nextTick();
  if (turn !== announcing) return;
  announcement.value = t("shell.notices.announce", { count }, count);
});

/**
 * Where the focus goes back as the panel closes. It returns to what had it
 * when the panel opened (the sidebar's «Avisos»), as the dialog does by
 * itself. On a phone that entry was in the drawer, which closed as the
 * panel opened, so the focus goes to the menu button that opens the drawer
 * again (ShellNavbarToggle), never to the page's body.
 */
let opener: Element | null = null;
watch(
  open,
  (value) => {
    if (value) opener = document.activeElement;
  },
  { flush: "sync" },
);
const panelContent = {
  onCloseAutoFocus: (event: Event) => {
    // A tap that focused nothing leaves the body: the button is better.
    if (opener?.isConnected && opener !== document.body) return;
    const toggle = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-testid="navbar-toggle"] button',
      ),
    ].find((button) => button.isConnected && button.offsetParent !== null);
    if (!toggle) return;
    event.preventDefault();
    toggle.focus();
  },
};

onMounted(refreshThrottled);
watch(
  () => route.path,
  () => refreshThrottled(),
);
// A row is a link: following it (another page, or another amendment of
// the same one) closes the panel.
watch(
  () => route.fullPath,
  () => closePanel(),
);
const visibility = useDocumentVisibility();
watch(visibility, (state) => {
  if (state === "visible") refreshThrottled();
});
onBeforeUnmount(dispose);

function onOpenUpdate(value: boolean): void {
  if (!value) closePanel();
}
</script>

<template>
  <div>
    <p class="sr-only" aria-live="polite" aria-atomic="true">
      {{ announcement }}
    </p>

    <USlideover
      :open="open"
      side="left"
      :title="t('shell.notices.title')"
      :description="description"
      :content="panelContent"
      @update:open="onOpenUpdate"
    >
      <template #body>
        <div
          v-if="!data && !failed"
          class="space-y-4"
          role="status"
          data-testid="notices-loading"
        >
          <span class="sr-only">{{ t("shell.notices.loading") }}</span>
          <div v-for="n in 3" :key="n" class="flex gap-3">
            <USkeleton
              aria-hidden="true"
              class="size-5 shrink-0 rounded-full"
            />
            <div class="flex-1 space-y-2">
              <USkeleton aria-hidden="true" class="h-4 w-3/4" />
              <USkeleton aria-hidden="true" class="h-3 w-1/2" />
            </div>
          </div>
        </div>

        <UAlert
          v-else-if="!data"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :title="t('shell.notices.loadError')"
          :actions="[
            {
              label: t('shell.notices.retry'),
              color: 'error',
              variant: 'outline',
              onClick: () => void retry(),
            },
          ]"
        />

        <CommonEmptyState
          v-else-if="news.length === 0"
          icon="i-lucide-bell-off"
          :title="t('shell.notices.empty')"
          :description="emptyDescription"
          size="sm"
        />

        <div v-else class="flex flex-col gap-6" data-testid="notices-lists">
          <section
            v-if="lists.fresh.length > 0"
            aria-labelledby="notices-fresh-title"
            class="flex flex-col gap-3"
          >
            <h3
              id="notices-fresh-title"
              class="text-highlighted text-sm font-semibold"
            >
              {{ t("shell.notices.fresh") }}
            </h3>
            <HomeNewsList :news="lists.fresh" :initial="lists.fresh.length" />
          </section>
          <section
            v-if="lists.earlier.length > 0"
            aria-labelledby="notices-earlier-title"
            class="flex flex-col gap-3"
          >
            <h3
              id="notices-earlier-title"
              class="text-highlighted text-sm font-semibold"
            >
              {{ t("shell.notices.earlier") }}
            </h3>
            <HomeNewsList :news="lists.earlier" />
          </section>
        </div>
      </template>
    </USlideover>
  </div>
</template>
