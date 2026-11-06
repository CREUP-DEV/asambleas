import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The daily intranet jobs with pg-boss, the intranet configuration, the
// roster sync and the access re-check stubbed.

const syncIntranetRoster = vi.fn();
const getIntranetApiBaseUrl = vi.fn((): string | null => "https://intranet");
const isAccessRecheckEnabled = vi.fn((): boolean => true);
const recheckIntranetAccess = vi.fn();
const logWarn = vi.fn();
const logError = vi.fn();

/** The pg-boss instances startIntranetSchedules created. */
const instances: FakeBoss[] = [];

class FakeBoss {
  options: unknown;
  started = false;
  stopped = false;
  createQueue = vi.fn(async () => undefined);
  schedule = vi.fn(async () => undefined);
  unschedule = vi.fn(async () => undefined);
  work = vi.fn(async () => "worker-id");
  on = vi.fn();
  constructor(options: unknown) {
    this.options = options;
    instances.push(this);
  }
  async start() {
    this.started = true;
    return this;
  }
  async stop() {
    this.stopped = true;
  }
}

vi.mock("pg-boss", () => ({ PgBoss: FakeBoss }));
vi.mock("./sync", () => ({ syncIntranetRoster }));
vi.mock("./intranet", () => ({ getIntranetApiBaseUrl }));
vi.mock("../auth/accessRecheck", () => ({
  isAccessRecheckEnabled,
  recheckIntranetAccess,
}));
vi.mock("../core/logger", () => ({ logInfo: vi.fn(), logWarn, logError }));

const {
  ACCESS_RECHECK_QUEUE,
  ROSTER_SYNC_QUEUE,
  handleAccessRecheckJobs,
  handleRosterSyncJobs,
  isRosterSyncScheduleEnabled,
  isRosterSyncSwitchOn,
  runScheduledAccessRecheck,
  runScheduledRosterSync,
  setupAccessRecheckSchedule,
  setupRosterSyncSchedule,
  startIntranetSchedules,
  stopIntranetSchedules,
} = await import("./schedule");

beforeEach(() => {
  vi.stubEnv("NUXT_INTRANET_ROSTER_SYNC", undefined);
  vi.stubEnv("DATABASE_URL", undefined);
  getIntranetApiBaseUrl.mockReturnValue("https://intranet");
  isAccessRecheckEnabled.mockReturnValue(true);
  syncIntranetRoster.mockReset();
  recheckIntranetAccess.mockReset();
  logWarn.mockClear();
  logError.mockClear();
  instances.length = 0;
});

afterEach(async () => {
  await stopIntranetSchedules();
  vi.unstubAllEnvs();
});

describe("isRosterSyncSwitchOn", () => {
  it.each([
    [undefined, true],
    ["", true],
    ["true", true],
    ["0", true],
    ["no", true],
    ["false", false],
    [" FALSE ", false],
  ])("%p is %s", (value, on) => {
    expect(isRosterSyncSwitchOn(value)).toBe(on);
  });
});

describe("isRosterSyncScheduleEnabled", () => {
  it("needs the intranet URL and the switch not off", () => {
    expect(isRosterSyncScheduleEnabled()).toBe(true);
    vi.stubEnv("NUXT_INTRANET_ROSTER_SYNC", "false");
    expect(isRosterSyncScheduleEnabled()).toBe(false);
    vi.stubEnv("NUXT_INTRANET_ROSTER_SYNC", undefined);
    getIntranetApiBaseUrl.mockReturnValue(null);
    expect(isRosterSyncScheduleEnabled()).toBe(false);
  });
});

describe("setupRosterSyncSchedule", () => {
  it("creates the queue, schedules 05:00 Madrid time and starts the worker", async () => {
    const boss = new FakeBoss({});
    await expect(setupRosterSyncSchedule(boss)).resolves.toBe("scheduled");
    expect(boss.createQueue).toHaveBeenCalledWith(
      ROSTER_SYNC_QUEUE,
      expect.objectContaining({ retryLimit: 2 }),
    );
    expect(boss.schedule).toHaveBeenCalledWith(
      ROSTER_SYNC_QUEUE,
      "0 5 * * *",
      null,
      expect.objectContaining({ tz: "Europe/Madrid" }),
    );
    expect(boss.work).toHaveBeenCalledWith(
      ROSTER_SYNC_QUEUE,
      expect.objectContaining({ batchSize: 1 }),
      handleRosterSyncJobs,
    );
    expect(boss.unschedule).not.toHaveBeenCalled();
  });

  it.each([
    [
      "the switch is off",
      () => vi.stubEnv("NUXT_INTRANET_ROSTER_SYNC", "false"),
    ],
    [
      "there is no intranet URL",
      () => getIntranetApiBaseUrl.mockReturnValue(null),
    ],
  ])("removes the schedule when %s", async (_case, turnOff) => {
    turnOff();
    const boss = new FakeBoss({});
    await expect(setupRosterSyncSchedule(boss)).resolves.toBe("disabled");
    expect(boss.createQueue).toHaveBeenCalled();
    expect(boss.unschedule).toHaveBeenCalledWith(ROSTER_SYNC_QUEUE);
    expect(boss.schedule).not.toHaveBeenCalled();
    expect(boss.work).not.toHaveBeenCalled();
  });
});

describe("runScheduledRosterSync", () => {
  it("runs with no actor, as scheduled, and never confirms", async () => {
    const outcome = {
      status: "applied",
      result: { created: 0, updated: 1, deactivated: 0 },
    };
    syncIntranetRoster.mockResolvedValue(outcome);
    await expect(runScheduledRosterSync()).resolves.toEqual(outcome);
    expect(syncIntranetRoster).toHaveBeenCalledWith({
      event: null,
      actor: null,
      trigger: "scheduled",
      confirmDeactivation: false,
    });
  });

  it("completes and warns when the sync was refused", async () => {
    const outcome = {
      status: "blocked",
      kinds: [{ kind: "sectorial", active: 12, toDeactivate: 12 }],
    };
    syncIntranetRoster.mockResolvedValue(outcome);
    await expect(runScheduledRosterSync()).resolves.toEqual(outcome);
    expect(logWarn).toHaveBeenCalledWith(
      "members.schedule",
      expect.objectContaining({ kinds: outcome.kinds }),
    );
  });

  it("rethrows a failure so pg-boss retries it", async () => {
    const error = Object.assign(new Error("bad gateway"), { statusCode: 502 });
    syncIntranetRoster.mockRejectedValue(error);
    await expect(runScheduledRosterSync()).rejects.toBe(error);
    expect(logWarn).toHaveBeenCalledWith(
      "members.schedule",
      expect.objectContaining({ statusCode: 502 }),
    );
  });

  it("skips the run when the daily sync was turned off meanwhile", async () => {
    vi.stubEnv("NUXT_INTRANET_ROSTER_SYNC", "false");
    await expect(runScheduledRosterSync()).resolves.toBeNull();
    expect(syncIntranetRoster).not.toHaveBeenCalled();
  });

  it("runs once per job", async () => {
    syncIntranetRoster.mockResolvedValue({ status: "applied", result: {} });
    await handleRosterSyncJobs([{ id: "a" }, { id: "b" }] as never);
    expect(syncIntranetRoster).toHaveBeenCalledTimes(2);
  });
});

describe("setupAccessRecheckSchedule", () => {
  it("creates the queue, schedules 05:30 Madrid time and starts the worker", async () => {
    const boss = new FakeBoss({});
    await expect(setupAccessRecheckSchedule(boss)).resolves.toBe("scheduled");
    expect(boss.createQueue).toHaveBeenCalledWith(
      ACCESS_RECHECK_QUEUE,
      expect.objectContaining({ retryLimit: 2 }),
    );
    expect(boss.schedule).toHaveBeenCalledWith(
      ACCESS_RECHECK_QUEUE,
      "30 5 * * *",
      null,
      expect.objectContaining({ tz: "Europe/Madrid" }),
    );
    expect(boss.work).toHaveBeenCalledWith(
      ACCESS_RECHECK_QUEUE,
      expect.objectContaining({ batchSize: 1 }),
      handleAccessRecheckJobs,
    );
  });

  it("does not depend on the roster sync switch", async () => {
    vi.stubEnv("NUXT_INTRANET_ROSTER_SYNC", "false");
    const boss = new FakeBoss({});
    await expect(setupAccessRecheckSchedule(boss)).resolves.toBe("scheduled");
  });

  it("removes the schedule without an authenticated role lookup", async () => {
    isAccessRecheckEnabled.mockReturnValue(false);
    const boss = new FakeBoss({});
    await expect(setupAccessRecheckSchedule(boss)).resolves.toBe("disabled");
    expect(boss.unschedule).toHaveBeenCalledWith(ACCESS_RECHECK_QUEUE);
    expect(boss.schedule).not.toHaveBeenCalled();
    expect(boss.work).not.toHaveBeenCalled();
  });
});

describe("runScheduledAccessRecheck", () => {
  it("runs the re-check and returns its outcome", async () => {
    const outcome = {
      status: "applied",
      checked: 4,
      notFound: 1,
      failed: 0,
      revoked: 1,
    };
    recheckIntranetAccess.mockResolvedValue(outcome);
    await expect(runScheduledAccessRecheck()).resolves.toEqual(outcome);
  });

  it("completes a blocked run", async () => {
    const outcome = { status: "blocked", checked: 10, notFound: 9, failed: 0 };
    recheckIntranetAccess.mockResolvedValue(outcome);
    await expect(runScheduledAccessRecheck()).resolves.toEqual(outcome);
  });

  it("throws when the intranet cut the run short, so pg-boss retries it", async () => {
    recheckIntranetAccess.mockResolvedValue({
      status: "aborted",
      checked: 0,
      failed: 5,
    });
    await expect(runScheduledAccessRecheck()).rejects.toThrow(/aborted/);
  });

  it("skips the run when it was turned off meanwhile", async () => {
    isAccessRecheckEnabled.mockReturnValue(false);
    await expect(runScheduledAccessRecheck()).resolves.toBeNull();
    expect(recheckIntranetAccess).not.toHaveBeenCalled();
  });

  it("runs once per job", async () => {
    recheckIntranetAccess.mockResolvedValue({ status: "skipped" });
    await handleAccessRecheckJobs([{ id: "a" }, { id: "b" }] as never);
    expect(recheckIntranetAccess).toHaveBeenCalledTimes(2);
  });
});

describe("startIntranetSchedules", () => {
  it("does nothing without a database", async () => {
    await expect(startIntranetSchedules()).resolves.toBeNull();
    expect(instances).toEqual([]);
  });

  it("starts one instance, however many times it is called", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://test");
    const [first, second] = await Promise.all([
      startIntranetSchedules(),
      startIntranetSchedules(),
    ]);
    expect(instances).toHaveLength(1);
    expect(first).toBe(instances[0]);
    expect(second).toBe(first);
    expect(instances[0]!.started).toBe(true);
    expect(instances[0]!.work).toHaveBeenCalled();

    await stopIntranetSchedules();
    expect(instances[0]!.stopped).toBe(true);
  });

  it("keeps the instance for the re-check when the roster sync is off", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://test");
    vi.stubEnv("NUXT_INTRANET_ROSTER_SYNC", "false");
    const boss = await startIntranetSchedules();
    expect(boss).toBe(instances[0]);
    expect(instances[0]!.unschedule).toHaveBeenCalledWith(ROSTER_SYNC_QUEUE);
    expect(instances[0]!.work).toHaveBeenCalledWith(
      ACCESS_RECHECK_QUEUE,
      expect.anything(),
      handleAccessRecheckJobs,
    );
    expect(instances[0]!.stopped).toBe(false);
  });

  it("stops the instance again when both jobs are off", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://test");
    vi.stubEnv("NUXT_INTRANET_ROSTER_SYNC", "false");
    isAccessRecheckEnabled.mockReturnValue(false);
    await expect(startIntranetSchedules()).resolves.toBeNull();
    expect(instances[0]!.unschedule).toHaveBeenCalledWith(ROSTER_SYNC_QUEUE);
    expect(instances[0]!.unschedule).toHaveBeenCalledWith(ACCESS_RECHECK_QUEUE);
    expect(instances[0]!.stopped).toBe(true);
  });
});
