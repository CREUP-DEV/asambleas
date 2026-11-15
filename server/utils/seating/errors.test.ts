import { DrizzleQueryError } from "drizzle-orm/errors";
import { createError } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/logger", () => ({ logError: vi.fn() }));

const { logError } = await import("../core/logger");
const { pgErrorCode, throwSeatingError } = await import("./errors");

// Invented names: never real attendees.
const failedInsert = (code: string) =>
  new DrizzleQueryError(
    'insert into "seating_people" ("id", "first_name", "surname") values ($1, $2, $3)',
    ["abc", "Nombreinventado", "Apellido Inventado"],
    Object.assign(new Error("canceling statement due to statement timeout"), {
      code,
    }),
  );

const thrown = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error as { statusCode?: number; message?: string };
  }
  return null;
};

beforeEach(() => vi.mocked(logError).mockClear());

describe("throwSeatingError", () => {
  it("never logs the names a failed query carried", () => {
    const error = failedInsert("57014");
    // What throwMutationError would have logged: the query's parameters.
    expect(error.message).toContain("Nombreinventado");
    expect(
      thrown(() => throwSeatingError("seating.sync", error)),
    ).toMatchObject({
      statusCode: 500,
      message: "Error al procesar la solicitud",
    });
    expect(logError).toHaveBeenCalledWith(
      "seating.sync",
      { name: "DrizzleQueryError", pgCode: "57014" },
      undefined,
      undefined,
    );
    const logged = JSON.stringify(vi.mocked(logError).mock.calls);
    expect(logged).not.toContain("Nombreinventado");
    expect(logged).not.toContain("Apellido");
  });

  it("answers a unique violation with the usual 409, logging nothing", () => {
    expect(
      thrown(() => throwSeatingError("seating.person", failedInsert("23505"))),
    ).toMatchObject({ statusCode: 409 });
    expect(logError).not.toHaveBeenCalled();
  });

  it("passes an HTTP error on as it is", () => {
    const refusal = createError({ statusCode: 422, message: "No" });
    expect(thrown(() => throwSeatingError("seating.person", refusal))).toBe(
      refusal,
    );
    expect(logError).not.toHaveBeenCalled();
  });
});

describe("pgErrorCode", () => {
  it("reads the SQLSTATE through drizzle's wrapping", () => {
    expect(pgErrorCode(failedInsert("22021"))).toBe("22021");
    expect(pgErrorCode(new Error("no code"))).toBeNull();
    expect(pgErrorCode(null)).toBeNull();
  });
});
