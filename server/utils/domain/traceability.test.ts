/**
 * Guards of the traceability rules (docs/design.md, "Traceability"):
 *
 * 1. Only recordAudit (server/utils/domain/audit.ts) inserts into audit_log.
 * 2. Every mutation endpoint (server/api/**\/*.{post,put,patch,delete}.ts)
 *    leaves a record: it calls recordEvent or recordAudit, or a server
 *    function that does, as far as a static call graph can tell.
 * 3. recordAudit stays loadable by the seed under tsx (no Nuxt aliases at
 *    runtime).
 * 4. Endpoints take identity from the caller (getAuthUserWithRole,
 *    requireActor, the RBAC helpers), never from `session.user`, which stays
 *    the real Admin's while impersonating.
 *
 * The scans read the source with the TypeScript parser (no type checker), so
 * they are fast and need no database.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const toRel = (path: string) => relative(root, path).split(sep).join("/");

const SOURCE_EXTENSION = /\.(ts|mts|js|mjs)$/;

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return SOURCE_EXTENSION.test(name) && !/\.test\.ts$/.test(name)
      ? [path]
      : [];
  });
}

const read = (path: string) => readFileSync(path, "utf8");

// 1. audit_log writers ----------------------------------------------------

const AUDIT_WRITER = "server/utils/domain/audit.ts";
const INSERT_AUDIT_LOG = /\.insert\(\s*(?:[\w$]+\.)?auditLog\s*\)/;
const RAW_INSERT_AUDIT_LOG = /insert\s+into\s+(?:"?public"?\.)?"?audit_log\b/i;

describe("audit_log writers", () => {
  // Server code, the seed, scripts and ops: everything that reaches the
  // database. SQL migrations are not scanned (they create the table).
  const files = ["server", "drizzle", "scripts", "ops", "shared"].flatMap(
    (dir) => sourceFiles(join(root, dir)),
  );

  it("insert only through recordAudit", () => {
    const writers = files
      .filter((path) => INSERT_AUDIT_LOG.test(read(path)))
      .map(toRel);
    // The scan sees recordAudit itself, so it is looking in the right place.
    expect(writers).toContain(AUDIT_WRITER);
    expect(writers.filter((path) => path !== AUDIT_WRITER)).toEqual([]);
  });

  it("never insert with raw SQL", () => {
    expect(
      files.filter((path) => RAW_INSERT_AUDIT_LOG.test(read(path))).map(toRel),
    ).toEqual([]);
  });
});

// 2. Every mutation records -----------------------------------------------

/** The functions that write the history. */
const RECORDERS = new Set(["recordEvent", "recordAudit"]);

/**
 * Functions whose own records do not record the endpoint's change. Every
 * request resolves its user through resolveImpersonation, which may close a
 * stale impersonation (and write that row): without this barrier every
 * authenticated endpoint would look like it records.
 */
const BARRIERS = new Set([
  "server/utils/auth/impersonation.ts#resolveImpersonation",
]);

/**
 * Mutation endpoints that write nothing and so record nothing. Each entry
 * says why; the test fails if one of them starts recording (drop it then)
 * or stops existing.
 */
const NON_RECORDING_MUTATIONS: Readonly<Record<string, string>> = {
  // Heartbeat of an open draft editor: who is editing lives only in
  // memory (server/utils/live/presence.ts) and expires in seconds. Recording
  // each beat would fill the history and wake every live listener.
  "server/api/assemblies/[assembly]/documents/[document]/presence.post.ts":
    "presence heartbeat, memory only",
};

interface ModuleInfo {
  /** Local name -> the module file and the name it exports. */
  imports: Map<string, { file: string; name: string }>;
  /** Top-level function name -> identifiers it calls or passes along. */
  functions: Map<string, Set<string>>;
  /** Every identifier called or passed along anywhere in the file. */
  calls: Set<string>;
}

const moduleCache = new Map<string, ModuleInfo>();

function resolveImport(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("~~/")) base = join(root, specifier.slice(3));
  else if (specifier.startsWith("~/"))
    base = join(root, "app", specifier.slice(2));
  else if (specifier.startsWith(".")) base = resolve(dirname(from), specifier);
  else return null;
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.mts`,
    join(base, "index.ts"),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * The identifiers a node calls (`f(...)`) or hands to another call
 * (`items.map(f)`, `db.transaction(f)`), nested callbacks included.
 */
function calledIdentifiers(node: ts.Node, into = new Set<string>()) {
  const visit = (current: ts.Node) => {
    if (ts.isCallExpression(current)) {
      if (ts.isIdentifier(current.expression)) {
        into.add(current.expression.text);
      }
      for (const argument of current.arguments) {
        if (ts.isIdentifier(argument)) into.add(argument.text);
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return into;
}

function loadModule(file: string): ModuleInfo {
  const cached = moduleCache.get(file);
  if (cached) return cached;
  const source = ts.createSourceFile(
    file,
    read(file),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const info: ModuleInfo = {
    imports: new Map(),
    functions: new Map(),
    calls: calledIdentifiers(source),
  };
  for (const statement of source.statements) {
    if (
      (ts.isImportDeclaration(statement) ||
        ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const target = resolveImport(file, statement.moduleSpecifier.text);
      if (!target) continue;
      const elements = ts.isImportDeclaration(statement)
        ? statement.importClause?.namedBindings &&
          ts.isNamedImports(statement.importClause.namedBindings)
          ? statement.importClause.namedBindings.elements
          : []
        : statement.exportClause && ts.isNamedExports(statement.exportClause)
          ? statement.exportClause.elements
          : [];
      for (const element of elements) {
        info.imports.set(element.name.text, {
          file: target,
          name: (element.propertyName ?? element.name).text,
        });
      }
      continue;
    }
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      info.functions.set(statement.name.text, calledIdentifiers(statement));
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          info.functions.set(
            declaration.name.text,
            calledIdentifiers(declaration.initializer),
          );
        }
      }
    }
  }
  moduleCache.set(file, info);
  return info;
}

/**
 * The server functions that record, directly or through other server
 * functions: a fixpoint over the call graph of server/utils.
 */
function recordingFunctions(): {
  marked: Set<string>;
  nodes: Map<string, string[]>;
  barriers: Set<string>;
} {
  const files = sourceFiles(join(root, "server", "utils")).filter((path) =>
    path.endsWith(".ts"),
  );
  const nodes = new Map<string, string[]>();
  for (const file of files) {
    const info = loadModule(file);
    for (const [name, calls] of info.functions) {
      const edges: string[] = [];
      for (const call of calls) {
        if (RECORDERS.has(call)) edges.push(`#${call}`);
        else if (info.functions.has(call)) edges.push(`${file}#${call}`);
        else {
          const imported = info.imports.get(call);
          if (imported) edges.push(`${imported.file}#${imported.name}`);
        }
      }
      nodes.set(`${file}#${name}`, edges);
    }
  }
  const marked = new Set<string>([...RECORDERS].map((name) => `#${name}`));
  const barriers = new Set(
    [...BARRIERS].map((barrier) => {
      const [file, name] = barrier.split("#");
      return `${join(root, file!)}#${name}`;
    }),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const [node, edges] of nodes) {
      if (
        !marked.has(node) &&
        !barriers.has(node) &&
        edges.some((edge) => marked.has(edge))
      ) {
        marked.add(node);
        changed = true;
      }
    }
  }
  return { marked, nodes, barriers };
}

const graph = recordingFunctions();
const recording = graph.marked;

/** How an endpoint records: "direct", "graph" or null (it does not). */
function recordsThrough(file: string): "direct" | "graph" | null {
  const info = loadModule(file);
  if ([...info.calls].some((call) => RECORDERS.has(call))) return "direct";
  for (const call of info.calls) {
    const local = info.functions.get(call);
    if (local && [...local].some((inner) => RECORDERS.has(inner))) {
      return "direct";
    }
    const imported = info.imports.get(call);
    if (imported && recording.has(`${imported.file}#${imported.name}`)) {
      return "graph";
    }
  }
  return null;
}

const MUTATION_FILE = /\.(post|put|patch|delete)\.ts$/;
const mutations = sourceFiles(join(root, "server", "api"))
  .filter((path) => MUTATION_FILE.test(path))
  .map(toRel)
  .sort();

describe("mutation endpoints", () => {
  it("are found", () => {
    // A sanity floor: the scan must see the real API, not an empty folder.
    expect(mutations.length).toBeGreaterThan(40);
  });

  it("each record an event or an audit row", () => {
    const silent = mutations.filter(
      (path) =>
        !(path in NON_RECORDING_MUTATIONS) &&
        recordsThrough(join(root, path)) === null,
    );
    expect(silent).toEqual([]);
  });

  it("keep the allowlist exact", () => {
    for (const path of Object.keys(NON_RECORDING_MUTATIONS)) {
      expect(mutations, `${path} no longer exists`).toContain(path);
      expect(
        recordsThrough(join(root, path)),
        `${path} records now: remove it from NON_RECORDING_MUTATIONS`,
      ).toBeNull();
    }
  });

  it("keep the barriers real", () => {
    // A barrier that no longer exists would silently stop guarding.
    for (const barrier of graph.barriers) {
      expect(graph.nodes.has(barrier), `${toRel(barrier)} not found`).toBe(
        true,
      );
    }
  });

  it("follow domain functions through the call graph", () => {
    // Controls: an endpoint that records only through a domain function is
    // found through the graph.
    const submit =
      "server/api/assemblies/[assembly]/documents/[document]/amendments/[amendment]/submit.post.ts";
    expect(mutations).toContain(submit);
    expect(recordsThrough(join(root, submit))).toBe("graph");
    const node = (file: string, name: string) => `${join(root, file)}#${name}`;
    expect(
      recording.has(node("server/utils/export/enqueue.ts", "enqueueExport")),
    ).toBe(true);
    // The helpers every endpoint calls must not count as recording, or the
    // check would pass for any endpoint (resolveDocumentRoute lives in a
    // module full of recordEvent calls).
    for (const [file, name] of [
      ["server/utils/auth/requireAuth.ts", "requireAuth"],
      ["server/utils/auth/requireAuth.ts", "getAuthUserWithRole"],
      ["server/utils/auth/rbac.ts", "requirePermission"],
      ["server/utils/auth/rbac.ts", "requireAnyPermission"],
      ["server/utils/auth/rbac.ts", "requireAdmin"],
      ["server/utils/domain/actor.ts", "requireActor"],
      ["server/utils/domain/resolvers.ts", "resolveAssembly"],
      ["server/utils/domain/documents.ts", "resolveDocumentRoute"],
      ["server/utils/domain/documents.ts", "parseDocumentBody"],
      ["server/utils/errors.ts", "throwMutationError"],
    ] as const) {
      expect(graph.nodes.has(node(file, name)), `${name} not found`).toBe(true);
      expect(
        recording.has(node(file, name)),
        `${name} counts as recording`,
      ).toBe(false);
    }
  });
});

// 3. recordAudit loads under tsx (the seed) -------------------------------

describe("recordAudit's runtime imports", () => {
  it("are packages or the schema, never Nuxt aliases", () => {
    const file = join(root, AUDIT_WRITER);
    const source = ts.createSourceFile(
      file,
      read(file),
      ts.ScriptTarget.Latest,
      true,
    );
    const runtime: string[] = [];
    for (const statement of source.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        continue;
      }
      const clause = statement.importClause;
      const typeOnly =
        clause?.isTypeOnly ||
        (clause &&
          !clause.name &&
          clause.namedBindings &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.every((element) => element.isTypeOnly));
      if (!typeOnly) runtime.push(statement.moduleSpecifier.text);
    }
    expect(runtime.length).toBeGreaterThan(0);
    expect(
      runtime.filter(
        (specifier) =>
          /^[.~#]/.test(specifier) && specifier !== "../../db/schema",
      ),
    ).toEqual([]);
  });
});

// 4. Identity comes from the caller ----------------------------------------

/**
 * Whether the code (not its comments) reads `.user` off a session:
 * `session.user`, `session?.user`, `context.session?.user`...
 */
function readsSessionUser(file: string): boolean {
  const source = ts.createSourceFile(
    file,
    read(file),
    ts.ScriptTarget.Latest,
    true,
  );
  let found = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "user" &&
      ((ts.isIdentifier(node.expression) &&
        node.expression.text === "session") ||
        (ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "session"))
    ) {
      found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("endpoints", () => {
  it("never read identity from session.user", () => {
    const offenders = sourceFiles(join(root, "server", "api"))
      .filter(readsSessionUser)
      .map(toRel);
    expect(offenders).toEqual([]);
  });

  it("detect session.user in code only", () => {
    // Control for the parser: the identity helper does read it, by design.
    expect(
      readsSessionUser(join(root, "server/utils/auth/requireAuth.ts")),
    ).toBe(true);
  });
});
