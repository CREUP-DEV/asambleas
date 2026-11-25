import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createEvent } from "h3";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { fail, notFound, parseWith, readBodyWith, readQueryWith } from "./http";

const thrown = async (run: () => unknown) => {
  try {
    await run();
  } catch (error) {
    return error as { statusCode?: number; message?: string; data?: unknown };
  }
  return null;
};

/** An h3 event for a request with this body (raw text) and URL. */
function event(body: string | null, url = "/") {
  const req = new IncomingMessage(new Socket());
  req.method = "POST";
  req.url = url;
  req.headers["content-type"] = "application/json";
  if (body !== null) {
    req.headers["content-length"] = String(Buffer.byteLength(body));
    req.push(body);
  }
  req.push(null);
  return createEvent(req, new ServerResponse(req));
}

const schema = z.object({ name: z.string(), note: z.string().optional() });
const optional = z.object({ note: z.string().optional() });

describe("fail and notFound", () => {
  it("throw the status, the message and only a data that is there", async () => {
    expect(await thrown(() => fail(409, "Choca"))).toMatchObject({
      statusCode: 409,
      message: "Choca",
      data: undefined,
    });
    expect(
      await thrown(() => fail(422, "No", { messageKey: "a.b" })),
    ).toMatchObject({ statusCode: 422, data: { messageKey: "a.b" } });
    expect(
      await thrown(() => notFound("No está", { reason: "gone" })),
    ).toMatchObject({
      statusCode: 404,
      message: "No está",
      data: { reason: "gone" },
    });
  });
});

describe("parseWith", () => {
  it("answers 400 «Datos no válidos» with each issue's path and message", async () => {
    const error = await thrown(() => parseWith(schema, { name: 3 }));
    expect(error).toMatchObject({
      statusCode: 400,
      message: "Datos no válidos",
    });
    const { issues } = error!.data as { issues: { path: string }[] };
    expect(issues).toEqual([{ path: "name", message: expect.any(String) }]);
  });

  it("answers the caller's own text and data, without issues", async () => {
    expect(
      await thrown(() =>
        parseWith(schema, {}, { message: "Miembro no válido" }),
      ),
    ).toMatchObject({
      statusCode: 400,
      message: "Miembro no válido",
      data: undefined,
    });
    expect(
      await thrown(() =>
        parseWith(schema, {}, { message: "Motivo", data: { messageKey: "k" } }),
      ),
    ).toMatchObject({ message: "Motivo", data: { messageKey: "k" } });
  });

  it("returns the parsed value", () => {
    expect(parseWith(schema, { name: "a" })).toEqual({ name: "a" });
  });
});

describe("readBodyWith", () => {
  it("reads and validates a JSON body", async () => {
    await expect(readBodyWith(event('{"name":"a"}'), schema)).resolves.toEqual({
      name: "a",
    });
  });

  it("answers 400 to a body that is not JSON", async () => {
    expect(
      await thrown(() => readBodyWith(event("{nope"), schema)),
    ).toMatchObject({
      statusCode: 400,
      message: "Cuerpo de la petición no válido",
    });
  });

  it("hands an empty body to the schema as it is, or as `empty`", async () => {
    expect(
      await thrown(() => readBodyWith(event(null), optional)),
    ).toMatchObject({ statusCode: 400, message: "Datos no válidos" });
    await expect(
      readBodyWith(event(null), optional, { empty: {} }),
    ).resolves.toEqual({});
    await expect(
      readBodyWith(event("null"), optional, { empty: {} }),
    ).resolves.toEqual({});
  });
});

describe("readQueryWith", () => {
  it("answers 400 «Parámetros no válidos» without issues", async () => {
    const query = z.object({ page: z.coerce.number().int().min(1) });
    expect(readQueryWith(event(null, "/?page=2"), query)).toEqual({ page: 2 });
    expect(
      await thrown(() => readQueryWith(event(null, "/?page=0"), query)),
    ).toMatchObject({
      statusCode: 400,
      message: "Parámetros no válidos",
      data: undefined,
    });
    expect(
      await thrown(() =>
        readQueryWith(event(null, "/?page=x"), query, {
          message: "Consulta no válida",
        }),
      ),
    ).toMatchObject({ message: "Consulta no válida" });
  });
});

// The private copies this module replaced (ARQ-4) must not come back: a
// domain module refuses through `fail` and `notFound` from here.
describe("server/utils/domain", () => {
  it("has no private fail or notFound", () => {
    const root = fileURLToPath(new URL("../domain", import.meta.url));
    const files = (readdirSync(root, { recursive: true }) as string[])
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .map((file) => join(root, file));
    expect(files.length).toBeGreaterThan(10);
    const copies = files.filter((file) =>
      /^\s*(export\s+)?function\s+(fail|notFound)\s*\(/m.test(
        readFileSync(file, "utf8"),
      ),
    );
    expect(copies.map((file) => relative(root, file))).toEqual([]);
  });
});
