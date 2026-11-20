import type { AssemblyPackageStatusDto } from "~~/shared/types/api";
import type { PackageSelection } from "~~/shared/utils/schemas/export";

/**
 * The documentation package being prepared ("Descargar documentación"),
 * followed in the background: asking for it starts polling its status, and
 * the polling lives here, not in the dialog, so the dialog can be closed
 * and the user can go on browsing. When the package is ready (or fails)
 * and no dialog is following it, a toast says so, with the download.
 *
 * One entry per package (assembly, language, Word versions or not, and
 * the part chosen with the dialog's filters), kept for the browser tab's
 * life. Only the browser asks and polls. A part is named afterwards by the
 * key the server answers (`status.part.key`, `?filter=`).
 */

export interface PackageJob {
  status: AssemblyPackageStatusDto | null;
  /** The request is on its way. */
  asking: boolean;
  /** The request was refused, or polling it was. */
  failed: boolean;
  /** Dialogs showing it now: while one does, it needs no toast. */
  watchers: number;
}

export interface PackageTarget {
  /** The assembly's API base, "/api/assemblies/80-ago". */
  apiBase: string;
  locale: "es" | "en";
  editable: boolean;
  /** A part of the package; null for the whole of it. */
  selection: PackageSelection | null;
}

const POLL_FIRST_MS = 2_000;
const POLL_MAX_MS = 8_000;

const jobs = new Map<string, PackageJob>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** Bumped on every request, so a reply to an older one is dropped. */
const generations = new Map<string, number>();

/** A selection with its lists sorted, so the same choice reads the same. */
export function canonicalSelection(
  selection: PackageSelection,
): PackageSelection {
  const sorted = (values: string[] | null | undefined) =>
    values ? [...new Set(values)].sort() : values;
  return {
    documentIds: sorted(selection.documentIds) ?? null,
    texts: selection.texts ?? true,
    amendments: selection.amendments ?? "all",
    memberIds: sorted(selection.memberIds) ?? [],
    amendmentIds: sorted(selection.amendmentIds) ?? [],
  };
}

function keyOf(target: PackageTarget): string {
  const part = target.selection
    ? JSON.stringify(canonicalSelection(target.selection))
    : "";
  return `${target.apiBase}|${target.locale}|${target.editable ? 1 : 0}|${part}`;
}

function query(target: PackageTarget, filter: string | null): string {
  const base = `locale=${target.locale}&editable=${target.editable ? "1" : "0"}`;
  return filter ? `${base}&filter=${encodeURIComponent(filter)}` : base;
}

/** The download of a package, or of a part by the key the server gave it. */
export function packageDownloadUrl(
  target: PackageTarget,
  filter: string | null = null,
): string {
  return `${target.apiBase}/package/download?${query(target, filter)}`;
}

/** The key a part's status and download take, once the server answered. */
function filterOf(entry: PackageJob): string | null {
  return entry.status?.part?.key ?? null;
}

function newJob(): PackageJob {
  return reactive({ status: null, asking: false, failed: false, watchers: 0 });
}

export function usePackageDownload() {
  const api = useApi();
  const toast = useToast();
  const { t } = useI18n();

  /** The package's state; the same object for every caller in the tab. */
  function job(target: PackageTarget): PackageJob {
    // The server renders no package state: a fresh one each time.
    if (import.meta.server) return newJob();
    const key = keyOf(target);
    let entry = jobs.get(key);
    if (!entry) {
      entry = newJob();
      jobs.set(key, entry);
    }
    return entry;
  }

  function stop(key: string): void {
    clearTimeout(timers.get(key));
    timers.delete(key);
  }

  /** Tells a user who closed the dialog that the package is ready or failed. */
  function announce(target: PackageTarget, entry: PackageJob): void {
    if (entry.watchers > 0) return;
    if (entry.status?.status === "ready") {
      toast.add({
        id: `package-${keyOf(target)}`,
        title: t("assembly.package.ready"),
        description: t("assembly.package.readyToast"),
        color: "success",
        icon: "i-lucide-folder-check",
        duration: 0,
        actions: [
          {
            label: t("assembly.package.downloadShort"),
            icon: "i-lucide-download",
            onClick: () => {
              window.location.assign(
                packageDownloadUrl(target, filterOf(entry)),
              );
            },
          },
        ],
      });
    } else if (entry.failed || entry.status?.status === "failed") {
      toast.add({
        id: `package-${keyOf(target)}`,
        title: t("assembly.package.failed"),
        color: "error",
        icon: "i-lucide-circle-alert",
      });
    }
  }

  function schedule(
    target: PackageTarget,
    delay: number,
    generation: number,
  ): void {
    const key = keyOf(target);
    stop(key);
    timers.set(
      key,
      setTimeout(() => void poll(target, delay, generation), delay),
    );
  }

  async function poll(
    target: PackageTarget,
    delay: number,
    generation: number,
  ): Promise<void> {
    const key = keyOf(target);
    if (generations.get(key) !== generation) return;
    const entry = job(target);
    try {
      const next = await api.get<AssemblyPackageStatusDto>(
        `${target.apiBase}/package/status?${query(target, filterOf(entry))}`,
      );
      if (generations.get(key) !== generation) return;
      entry.status = next;
      if (next.status !== "building") {
        timers.delete(key);
        announce(target, entry);
        return;
      }
    } catch (error) {
      if (generations.get(key) !== generation) return;
      // A network hiccup is retried; a refusal ends it.
      const code = api.errorStatus(error);
      if (code !== null && code < 500) {
        api.notifyError(error, "assembly.package.error");
        entry.failed = true;
        timers.delete(key);
        return;
      }
    }
    schedule(
      target,
      Math.min(Math.round(delay * 1.5), POLL_MAX_MS),
      generation,
    );
  }

  /**
   * Asks for the package and follows it until it is ready. A package
   * already being followed is not asked for again.
   */
  async function request(target: PackageTarget): Promise<void> {
    if (import.meta.server) return;
    const key = keyOf(target);
    const entry = job(target);
    if (timers.has(key) || entry.asking) return;
    const generation = (generations.get(key) ?? 0) + 1;
    generations.set(key, generation);
    entry.asking = true;
    entry.failed = false;
    try {
      const next = await api.send<AssemblyPackageStatusDto>(
        `${target.apiBase}/package`,
        {
          body: {
            locale: target.locale,
            editable: target.editable,
            selection: target.selection
              ? canonicalSelection(target.selection)
              : null,
          },
        },
      );
      if (generations.get(key) !== generation) return;
      entry.status = next;
      if (next.status === "building") {
        schedule(target, POLL_FIRST_MS, generation);
      }
    } catch (error) {
      if (generations.get(key) !== generation) return;
      entry.failed = true;
      api.notifyError(error, "assembly.package.error");
    } finally {
      if (generations.get(key) === generation) entry.asking = false;
    }
  }

  return { job, request };
}
