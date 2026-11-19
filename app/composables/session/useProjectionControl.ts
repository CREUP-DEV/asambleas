import type { ComputedRef, MaybeRefOrGetter, Ref } from "vue";
import type { ProjectionControlDto } from "~~/shared/types/api";
import { errorStatus, isIdentityChanged, useApi } from "../api/useApi";
import { resolveConsoleTabId, setConsoleTab } from "./consoleTab";

/** Beat of an open console; the server forgets a tab after 90 s. */
export const CONTROL_HEARTBEAT_MS = 15_000;

/** Statuses after which this tab stops beating: it may not moderate. */
const FINAL_STATUSES = new Set([401, 403, 404]);

export interface ProjectionControl {
  /** The latest answer; null until the first one. */
  state: Readonly<Ref<ProjectionControlDto | null>>;
  /** This tab decides what is on screen. */
  inControl: ComputedRef<boolean>;
  /** Who holds control, when it is another console. */
  holderName: ComputedRef<string | null>;
  /** The holder is another tab of this same account. */
  holderSameAccount: ComputedRef<boolean>;
  /** Takes control of the projection; nothing changes on screen. */
  take: () => Promise<boolean>;
  taking: Readonly<Ref<boolean>>;
  /** Asks again who holds control (after a live `projection` event). */
  refresh: () => Promise<void>;
}

/**
 * Control of the projection from the session console (user's decision of
 * 2026-11-19; server/utils/live/projectionControl.ts): this tab beats while
 * open, takes control when asked, and says goodbye when it closes. The
 * first console to open holds it; when its tab closes or goes silent it
 * passes to the console open longest, which says so in a toast, as it does
 * when someone else takes it. Client only; a failed beat keeps the last
 * answer, and a refusal (no longer the Mesa) stops beating.
 */
export function useProjectionControl(
  apiBase: MaybeRefOrGetter<string>,
): ProjectionControl {
  const state = ref<ProjectionControlDto | null>(null);
  const taking = ref(false);
  const inControl = computed(() => state.value?.holder?.you === true);
  const holderName = computed(() =>
    state.value?.holder && !state.value.holder.you
      ? state.value.holder.name
      : null,
  );
  const holderSameAccount = computed(
    () =>
      !!state.value?.holder &&
      !state.value.holder.you &&
      state.value.holder.sameAccount,
  );

  if (import.meta.server) {
    return {
      state,
      inControl,
      holderName,
      holderSameAccount,
      take: async () => false,
      taking,
      refresh: async () => {},
    };
  }

  const { send, notifyError } = useApi();
  const toast = useToast();
  const { t } = useI18n();
  const url = () => `${toValue(apiBase)}/projection-control`;
  let tabId: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  /** Control changed by this tab's own «Tomar el control»: no toast. */
  let ownTake = false;

  function apply(answer: ProjectionControlDto): void {
    const before = state.value;
    state.value = answer;
    if (!before || ownTake) return;
    const had = before.holder?.you === true;
    const has = answer.holder?.you === true;
    if (!had && has) {
      toast.add({
        id: "projection-control",
        title: t("session.control.gained"),
        description: t("session.control.gainedHint"),
        icon: "i-lucide-monitor-check",
        color: "success",
      });
    } else if (had && !has) {
      toast.add({
        id: "projection-control",
        title: answer.holder
          ? t("session.control.lostTo", { name: answer.holder.name })
          : t("session.control.lost"),
        description: t("session.control.lostHint"),
        icon: "i-lucide-monitor-x",
        color: "warning",
      });
    }
  }

  async function post(
    action: "beat" | "take" | "leave",
    keepalive = false,
  ): Promise<ProjectionControlDto | null> {
    if (!tabId) return null;
    return send<ProjectionControlDto>(url(), {
      body: { tabId, action },
      ...(keepalive ? { keepalive: true } : {}),
    });
  }

  function stop(): void {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  async function beat(): Promise<void> {
    if (stopped || !tabId) return;
    try {
      const answer = await post("beat");
      if (answer && !stopped) apply(answer);
    } catch (error) {
      const status = errorStatus(error);
      if (
        isIdentityChanged(error) ||
        (status !== null && FINAL_STATUSES.has(status))
      ) {
        stop();
      }
    }
  }

  async function take(): Promise<boolean> {
    if (!tabId || taking.value) return false;
    taking.value = true;
    ownTake = true;
    try {
      const answer = await post("take");
      if (answer) apply(answer);
      return answer?.holder?.you === true;
    } catch (error) {
      notifyError(error, "session.control.errors.take");
      return false;
    } finally {
      ownTake = false;
      taking.value = false;
    }
  }

  /** Best effort: whatever fails here expires on the server by itself. */
  function leave(): void {
    if (stopped || !tabId) return;
    post("leave", true).catch(() => undefined);
  }

  function onVisibility(): void {
    if (document.visibilityState === "visible") void beat();
  }

  /** Back from the browser's page cache, after `pagehide` said goodbye. */
  function onPageShow(event: PageTransitionEvent): void {
    if (event.persisted) void beat();
  }

  onMounted(async () => {
    tabId = await resolveConsoleTabId();
    if (stopped) return;
    setConsoleTab(tabId);
    void beat();
    timer = setInterval(() => void beat(), CONTROL_HEARTBEAT_MS);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", onPageShow);
  });

  onBeforeUnmount(() => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", leave);
    window.removeEventListener("pageshow", onPageShow);
    leave();
    stop();
    setConsoleTab(null);
  });

  return {
    state,
    inControl,
    holderName,
    holderSameAccount,
    take,
    taking,
    refresh: beat,
  };
}
