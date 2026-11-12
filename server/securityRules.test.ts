import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { defaultSecurityConfig } from "../node_modules/nuxt-security/dist/defaultConfig.mjs";
import { standardToSecurity } from "../node_modules/nuxt-security/dist/utils/headers.mjs";
import { defuReplaceArray } from "../node_modules/nuxt-security/dist/utils/merge.mjs";
import { amendmentDraftBodySchema } from "~~/shared/utils/schemas/amendment";

/**
 * The security options nuxt-security applies to each request, resolved from
 * nuxt.config.ts the way the module does it at runtime. There is no HTTP
 * harness in this repository (no @nuxt/test-utils), so this replays the
 * three steps the decision depends on and pins them to the library's source:
 *
 * 1. module install: the global options merged over `defaultSecurityConfig`;
 * 2. plugin `00-routeRules`: one entry per route rule whose plain `headers`
 *    name a security header, then `/**` from the global options, then one
 *    entry per route rule with `security`;
 * 3. `resolveSecurityRules`: every matching entry (radix3 `matchAll`, least
 *    specific first) reversed and merged with `defuReplaceArray`, so the most
 *    specific rule wins; `resolveSecurityRoute`: the rate limiter's bucket is
 *    the client IP plus the single rule radix3 `lookup` returns.
 *
 * If nuxt-security changes any of that, the source guard below fails and
 * this test must be re-derived.
 */

type Options = Record<string, unknown> & {
  enabled?: boolean;
  rateLimiter?: false | Record<string, unknown>;
  xssValidator?: false | Record<string, unknown>;
  requestSizeLimiter?: false | Record<string, unknown>;
};

interface Radix3 {
  createRouter: (options: { routes: Record<string, unknown> }) => {
    lookup: (path: string) => { name?: string } | null;
  };
  toRouteMatcher: (router: unknown) => {
    matchAll: (path: string) => Options[];
  };
}

interface XssModule {
  FilterXSS: new (options?: Record<string, unknown>) => {
    process: (value: string) => string;
  };
}

const root = fileURLToPath(new URL("..", import.meta.url));
const securityDir = realpathSync(join(root, "node_modules/nuxt-security"));
// radix3 and xss are nuxt-security's own dependencies, not hoisted.
const requireFromSecurity = createRequire(join(securityDir, "package.json"));
const radix3 = requireFromSecurity("radix3") as Radix3;
const { FilterXSS } = requireFromSecurity("xss") as XssModule;

function librarySource(relative: string): string {
  return readFileSync(join(securityDir, "dist", relative), "utf8");
}

let appSecurityOptions: Record<string, Options> = {};

function resolveRules(path: string): Options {
  const router = radix3.createRouter({
    routes: structuredClone(appSecurityOptions),
  });
  const matches = radix3.toRouteMatcher(router).matchAll(path);
  return defuReplaceArray({}, ...matches.reverse()) as Options;
}

function resolveBucket(path: string): string {
  const routes = Object.fromEntries(
    Object.keys(appSecurityOptions).map((name) => [name, { name }]),
  );
  return radix3.createRouter({ routes }).lookup(path)?.name ?? "";
}

beforeAll(async () => {
  vi.stubGlobal("defineNuxtConfig", (config: unknown) => config);
  // By a computed path, so the server type-check does not pull in
  // nuxt.config.ts (its `defineNuxtConfig` is only declared for the node one).
  const configPath = join(root, "nuxt.config.ts");
  const config = (await import(/* @vite-ignore */ configPath))
    .default as unknown as {
    security: Options;
    routeRules: Record<
      string,
      { headers?: Record<string, string>; security?: Options }
    >;
  };
  vi.unstubAllGlobals();

  // 1. module.mjs: `defuReplaceArray({ ...options, ...nuxt.options.security },
  //    defaultSecurityConfig(devServerUrl, strict))`, basicAuth moved out.
  const { basicAuth: _basicAuth, ...security } = defuReplaceArray(
    { ...config.security },
    defaultSecurityConfig("", Boolean(config.security.strict)),
  ) as Options;

  // 2. 00-routeRules.js. Its first loop gives a rule with plain `headers`
  // an entry of its own when one of them is a security header: that entry
  // would also become a rate limiter bucket (`resolveBucket`).
  appSecurityOptions = {};
  for (const [route, rule] of Object.entries(config.routeRules)) {
    const headers = standardToSecurity(rule.headers);
    if (headers) appSecurityOptions[route] = { headers };
  }
  appSecurityOptions["/**"] = defuReplaceArray(
    {},
    security,
    appSecurityOptions["/**"],
  ) as Options;
  for (const [route, rule] of Object.entries(config.routeRules)) {
    if (rule.security) {
      appSecurityOptions[route] = defuReplaceArray(
        {},
        JSON.parse(JSON.stringify(rule.security)),
        appSecurityOptions[route],
      ) as Options;
    }
  }
});

describe("nuxt-security resolution this test relies on", () => {
  it("still merges every matching rule, most specific first", () => {
    const context = librarySource("runtime/nitro/context/index.js");
    expect(context).toContain("matcher.matchAll(eventPathNoQuery)");
    expect(context).toContain("defuReplaceArray({}, ...matches.reverse())");
    expect(context).toContain("router.lookup(eventPathNoQuery)");
    expect(librarySource("utils/merge.mjs")).toContain("createDefu");
  });

  it("still builds one entry per rule over the global options", () => {
    const plugin = librarySource("runtime/nitro/plugins/00-routeRules.js");
    expect(plugin).toContain("standardToSecurity(headers2)");
    expect(plugin).toContain(
      "appSecurityOptions[route] = { headers: securityHeaders2 };",
    );
    expect(plugin).toContain('appSecurityOptions["/**"] = defuReplaceArray(');
    expect(plugin).toContain("appSecurityOptions[route] = defuReplaceArray(");
  });

  it("still keys the rate limiter on ip and rule, and skips it when false", () => {
    const limiter = librarySource("runtime/server/middleware/rateLimiter.js");
    expect(limiter).toContain("if (rules.enabled && rules.rateLimiter)");
    expect(limiter).toContain("const url = ip + route;");
    const xss = librarySource("runtime/server/middleware/xssValidator.js");
    expect(xss).toContain("if (rules.enabled && rules.xssValidator)");
  });
});

const ROOM_PATHS = [
  "/api/assemblies",
  "/api/assemblies/80-ago",
  "/api/assemblies/80-ago/live",
  "/api/assemblies/80-ago/agenda",
  "/api/assemblies/80-ago/documents/res-4",
  "/api/assemblies/80-ago/documents/res-4/reading",
  "/api/assemblies/80-ago/documents/res-4/amendments",
  "/api/assemblies/80-ago/documents/res-4/amendments/abc/position",
  "/api/assemblies/80-ago/headcounts",
  "/api/assemblies/80-ago/speakers",
  "/api/exports/0b9e/status",
  "/api/exports/0b9e/download",
  "/api/me",
  "/api/me/work",
  "/api/me/activity",
];

const LIMITED_PATHS = [
  "/",
  "/login",
  "/asambleas/80-ago",
  "/en/asambleas/80-ago",
  "/api/auth/get-session",
  "/api/auth/callback/google",
  "/api/members",
  "/api/members/sync",
];

const UPLOAD_RULES: Record<string, string> = {
  "/api/assemblies/80-ago/documents/res-4/import":
    "/api/assemblies/*/documents/*/import",
  "/api/assemblies/80-ago/documents/res-4/file":
    "/api/assemblies/*/documents/*/file",
  "/api/assemblies/80-ago/documents/res-4/images":
    "/api/assemblies/*/documents/*/images",
  "/api/assemblies/80-ago/convocation": "/api/assemblies/*/convocation",
};

const EXPORT_RULES: Record<string, string> = {
  "/api/assemblies/80-ago/export": "/api/assemblies/*/export",
  "/api/assemblies/80-ago/documents/res-4/export":
    "/api/assemblies/*/documents/*/export",
};

describe("rate limiter", () => {
  it.each(ROOM_PATHS)("is off for the room's API: %s", (path) => {
    const rules = resolveRules(path);
    expect(rules.enabled).toBe(true);
    expect(rules.rateLimiter).toBe(false);
  });

  it.each(LIMITED_PATHS)("stays on, in the global bucket: %s", (path) => {
    const rules = resolveRules(path);
    expect(rules.enabled).toBe(true);
    expect(rules.rateLimiter).toMatchObject({
      tokensPerInterval: 12000,
      interval: 300000,
    });
    expect(resolveBucket(path)).toBe("/**");
  });

  it.each(Object.entries(UPLOAD_RULES))(
    "gives uploads a bucket of their own: %s",
    (path, rule) => {
      expect(resolveRules(path).rateLimiter).toMatchObject({
        tokensPerInterval: 300,
        interval: 300_000,
        driver: { name: "lruCache" },
        throwError: true,
      });
      expect(resolveBucket(path)).toBe(rule);
    },
  );

  it.each(Object.entries(EXPORT_RULES))(
    "gives export requests a bucket of their own: %s",
    (path, rule) => {
      expect(resolveRules(path).rateLimiter).toMatchObject({
        tokensPerInterval: 1000,
        interval: 300_000,
        driver: { name: "lruCache" },
      });
      expect(resolveBucket(path)).toBe(rule);
    },
  );
});

describe("request size limits", () => {
  it("keep the assembly API's own limits", () => {
    expect(
      resolveRules("/api/assemblies/80-ago/documents/res-4").requestSizeLimiter,
    ).toMatchObject({
      maxRequestSizeInBytes: 6_000_000,
      maxUploadFileRequestInBytes: 8_000_000,
    });
  });

  it("keep each upload's own limit", () => {
    const limit = (path: string) =>
      (resolveRules(path).requestSizeLimiter as Record<string, number>)
        .maxUploadFileRequestInBytes;
    expect(limit("/api/assemblies/80-ago/documents/res-4/file")).toBe(
      21_000_000,
    );
    expect(limit("/api/assemblies/80-ago/documents/res-4/import")).toBe(
      16_000_000,
    );
    expect(limit("/api/assemblies/80-ago/convocation")).toBe(21_000_000);
    // A rule that only sets a rate limiter inherits the size limits.
    expect(limit("/api/assemblies/80-ago/documents/res-4/images")).toBe(
      8_000_000,
    );
  });
});

describe("xss validator", () => {
  // The texts that the validator refused (SEG-1), in an amendment draft.
  const draft = {
    kind: "partial",
    ops: [
      {
        op: "replace",
        blockId: "block-1",
        from: 0,
        to: 3,
        text: "según la <<Ley>> y por más del >50 %",
        baseText: "Ley",
      },
    ],
    justification: "a -> b, porque x < y",
  };

  it("would have refused plain text with < or >", () => {
    // What xssValidator.js compares, with the default options.
    const serialized = JSON.stringify(draft);
    expect(new FilterXSS({}).process(serialized)).not.toBe(serialized);
    // ...while real markup it lets through went unchanged.
    const markup = JSON.stringify({ text: "<b>hola</b>" });
    expect(new FilterXSS({}).process(markup)).toBe(markup);
  });

  it.each([
    ...ROOM_PATHS,
    ...LIMITED_PATHS,
    ...Object.keys(UPLOAD_RULES),
    ...Object.keys(EXPORT_RULES),
  ])("is off: %s", (path) => {
    expect(resolveRules(path).xssValidator).toBe(false);
  });

  it("leaves the amendment's text to Zod, which keeps it as written", () => {
    const parsed = amendmentDraftBodySchema.parse(draft);
    expect(parsed.ops[0]).toMatchObject({
      text: "según la <<Ley>> y por más del >50 %",
    });
    expect(parsed.justification).toBe("a -> b, porque x < y");
  });
});
