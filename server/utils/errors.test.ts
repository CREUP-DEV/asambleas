import { DrizzleQueryError } from "drizzle-orm/errors";
import { createError } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./core/logger", () => ({ logError: vi.fn() }));

const { logError } = await import("./core/logger");
const {
  errorSummary,
  funnelUnhandledError,
  isUniqueConstraintViolation,
  pgErrorCode,
  throwMutationError,
} = await import("./errors");

// Invented names: never real attendees.
const failedInsert = (code: string, constraint?: string) =>
  new DrizzleQueryError(
    'insert into "seating_people" ("id", "first_name", "surname") values ($1, $2, $3)',
    ["abc", "Nombreinventado", "Apellido Inventado"],
    Object.assign(new Error("canceling statement due to statement timeout"), {
      code,
      ...(constraint ? { constraint } : {}),
    }),
  );

const thrown = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error as {
      statusCode?: number;
      message?: string;
      data?: unknown;
    };
  }
  return null;
};

beforeEach(() => vi.mocked(logError).mockClear());

describe("throwMutationError", () => {
  it("never logs the parameters a failed query carried", () => {
    const error = failedInsert("57014");
    // What logging the error itself would leave: the query's parameters.
    expect(error.message).toContain("Nombreinventado");
    expect(
      thrown(() => throwMutationError("seating.sync", error)),
    ).toMatchObject({
      statusCode: 500,
      message: "Error al procesar la solicitud",
    });
    expect(logError).toHaveBeenCalledWith(
      "seating.sync",
      expect.objectContaining({
        name: "DrizzleQueryError",
        pgCode: "57014",
      }),
      undefined,
      undefined,
    );
    const logged = JSON.stringify(vi.mocked(logError).mock.calls);
    expect(logged).not.toContain("Nombreinventado");
    expect(logged).not.toContain("Apellido");
    expect(logged).not.toContain("statement timeout");
  });

  it("logs where an error that is not a query's was thrown, not its message", () => {
    thrown(() =>
      throwMutationError("amendments.note", new TypeError("nota secreta")),
    );
    const [, summary] = vi.mocked(logError).mock.calls[0]!;
    expect(summary).toMatchObject({ name: "TypeError", pgCode: null });
    expect((summary as { frames?: string[] }).frames?.[0]).toMatch(/^at /);
    expect(JSON.stringify(summary)).not.toContain("nota secreta");
  });

  it("answers a unique violation with the usual 409, logging nothing", () => {
    expect(
      thrown(() => throwMutationError("seating.person", failedInsert("23505"))),
    ).toMatchObject({
      statusCode: 409,
      message: "Ya existe un registro con esos datos",
    });
    expect(logError).not.toHaveBeenCalled();
  });

  it("passes an HTTP error on as it is", () => {
    const refusal = createError({ statusCode: 422, message: "No" });
    expect(thrown(() => throwMutationError("seating.person", refusal))).toBe(
      refusal,
    );
    expect(logError).not.toHaveBeenCalled();
  });
});

describe("pgErrorCode and isUniqueConstraintViolation", () => {
  it("read the SQLSTATE through drizzle's wrapping", () => {
    expect(pgErrorCode(failedInsert("22021"))).toBe("22021");
    expect(pgErrorCode(new Error("no code"))).toBeNull();
    expect(pgErrorCode(null)).toBeNull();
    expect(isUniqueConstraintViolation(failedInsert("23505"))).toBe(true);
    expect(isUniqueConstraintViolation({ code: "23505" })).toBe(true);
    expect(isUniqueConstraintViolation(failedInsert("23503"))).toBe(false);
    expect(isUniqueConstraintViolation(new Error("x"))).toBe(false);
  });

  it("skip a code that is not a SQLSTATE, such as a driver's", () => {
    const wrapped = Object.assign(new Error("lost"), {
      code: "ECONNRESET",
      cause: { code: "23505" },
    });
    expect(pgErrorCode(wrapped)).toBe("23505");
    expect(isUniqueConstraintViolation(wrapped)).toBe(true);
  });

  it("find a unique violation under another SQLSTATE, as before", () => {
    const outer = Object.assign(new Error("aborted"), {
      code: "25P02",
      cause: { code: "23505" },
    });
    expect(pgErrorCode(outer)).toBe("25P02");
    expect(isUniqueConstraintViolation(outer)).toBe(true);
  });
});

describe("errorSummary", () => {
  it("names the constraint, never the values", () => {
    const summary = errorSummary(
      failedInsert("23503", "seating_people_plan_id_fkey"),
    );
    expect(summary).toMatchObject({
      name: "DrizzleQueryError",
      pgCode: "23503",
      constraint: "seating_people_plan_id_fkey",
    });
    expect(JSON.stringify(summary)).not.toContain("Nombreinventado");
  });

  it("reads a value that is not an error by its type", () => {
    expect(errorSummary("boom")).toEqual({ name: "string", pgCode: null });
  });
});

describe("funnelUnhandledError", () => {
  // What h3 hands `onError` when a handler lets an error through.
  const unhandled = (error: unknown) => {
    const wrapped = createError(error as Error);
    wrapped.unhandled = true;
    return wrapped;
  };
  const apiEvent = { method: "POST", path: "/api/assemblies/x/documents" };
  const asEvent = (event: object) =>
    event as unknown as Parameters<typeof funnelUnhandledError>[1];

  it("answers a failed query with the generic 500, logging only its summary", () => {
    const error = unhandled(failedInsert("57014"));
    expect(error.message).toContain("Nombreinventado");
    funnelUnhandledError(error, asEvent(apiEvent));
    expect(error).toMatchObject({
      statusCode: 500,
      message: "Error al procesar la solicitud",
      unhandled: false,
    });
    expect(error.data).toBeUndefined();
    expect(error.statusMessage).toBeUndefined();
    expect(logError).toHaveBeenCalledWith(
      "unhandled",
      expect.objectContaining({ pgCode: "57014" }),
      undefined,
      apiEvent,
    );
    const logged = JSON.stringify(vi.mocked(logError).mock.calls[0]![1]);
    expect(logged).not.toContain("Nombreinventado");
    expect(logged).not.toContain("statement timeout");
  });

  it("names the error that was thrown, with where it was thrown", () => {
    funnelUnhandledError(
      unhandled(new TypeError("nota secreta")),
      asEvent(apiEvent),
    );
    const [, summary] = vi.mocked(logError).mock.calls[0]!;
    expect(summary).toMatchObject({ name: "TypeError", pgCode: null });
    expect((summary as { frames?: string[] }).frames?.[0]).toMatch(/^at /);
    expect(JSON.stringify(summary)).not.toContain("nota secreta");
  });

  it("answers a unique violation with the usual 409, logging nothing", () => {
    const error = unhandled(failedInsert("23505"));
    funnelUnhandledError(error, asEvent(apiEvent));
    expect(error).toMatchObject({
      statusCode: 409,
      message: "Ya existe un registro con esos datos",
      unhandled: false,
    });
    expect(logError).not.toHaveBeenCalled();
  });

  it("keeps the status a thrown value carried, with the generic text", () => {
    const forbidden = unhandled(
      Object.assign(new Error("token caducado de Nombreinventado"), {
        statusCode: 403,
      }),
    );
    funnelUnhandledError(forbidden, asEvent(apiEvent));
    expect(forbidden).toMatchObject({
      statusCode: 403,
      message: "Error al procesar la solicitud",
      unhandled: false,
    });
    const upstream = unhandled({ status: 502, message: "Bad Gateway" });
    funnelUnhandledError(upstream, asEvent(apiEvent));
    expect(upstream).toMatchObject({
      statusCode: 502,
      message: "Error al procesar la solicitud",
    });
    expect(logError).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(vi.mocked(logError).mock.calls)).not.toContain(
      "Nombreinventado",
    );
  });

  it("leaves an HTTP error as it is", () => {
    const refusal = createError({
      statusCode: 500,
      message: "No se pudo",
      data: { messageKey: "x" },
    });
    funnelUnhandledError(refusal, asEvent(apiEvent));
    expect(refusal).toMatchObject({
      statusCode: 500,
      message: "No se pudo",
      data: { messageKey: "x" },
    });
    expect(logError).not.toHaveBeenCalled();
  });

  it("leaves a page's error to Nuxt's error page", () => {
    const error = unhandled(new TypeError("render"));
    funnelUnhandledError(error, asEvent({ path: "/asambleas/80-ago" }));
    funnelUnhandledError(error, asEvent({ path: "/apiary" }));
    expect(error).toMatchObject({ unhandled: true, message: "render" });
    expect(logError).not.toHaveBeenCalled();
  });
});
