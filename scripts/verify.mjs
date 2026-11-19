// `pnpm verify`: AGENTS.md's verification checklist minus the build, with its
// steps run side by side instead of one after another (deploy.sh runs it
// before every build). `nuxt prepare` goes first and alone: it rewrites
// .nuxt/, which ESLint's config and vue-tsc's project references read, so the
// type check runs as `typecheck:tsc` (what `nuxt typecheck` runs once it has
// prepared). Each step's output is printed whole when it ends, so the logs of
// two steps never interleave. VERIFY_SERIAL=1 runs the steps one at a time,
// for a test that only fails under load.
//
// A pass leaves the hash of the tree it checked in VERIFIED_TREE_FILE (see
// treeHash), only when the tree did not change while it ran, so deploy.sh can
// skip verifying the very same tree again.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const VERIFIED_TREE_FILE = "node_modules/.cache/verify/tree";

/**
 * The git tree of the working directory as it is, uncommitted and untracked
 * files included (ignored ones left out), built in a copy of the index so the
 * real one is never touched. Null when git cannot tell. deploy.sh works it out
 * the same way.
 */
function treeHash() {
  const indexPath = spawnSync("git", ["rev-parse", "--git-path", "index"], {
    encoding: "utf8",
  });
  if (indexPath.status !== 0) return null;
  const index = join(tmpdir(), `verify-index-${process.pid}`);
  try {
    copyFileSync(resolve(indexPath.stdout.trim()), index);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    const add = spawnSync("git", ["add", "-A"], { env, encoding: "utf8" });
    if (add.status !== 0) return null;
    const tree = spawnSync("git", ["write-tree"], { env, encoding: "utf8" });
    return tree.status === 0 ? tree.stdout.trim() : null;
  } catch {
    return null;
  } finally {
    rmSync(index, { force: true });
  }
}

const PREPARE = "pnpm exec nuxt prepare";
const serial = process.env.VERIFY_SERIAL === "1";
// Each step is a script of package.json, but side by side the tests run with
// half the cores instead of all but one: vue-tsc and ESLint use one core each,
// and Vitest starving them made the whole run some 40 % slower.
const STEPS = [
  ["typecheck:tsc"],
  ["lint"],
  ["format:check"],
  ["i18n:check"],
  ["i18n:audit-identical"],
  ["test", serial ? undefined : "pnpm exec vitest run --maxWorkers=50%"],
].map(([label, command]) => ({
  label,
  command: command ?? `pnpm run -s ${label}`,
}));
const colour = process.stdout.isTTY ? { FORCE_COLOR: "1" } : {};

/** Runs a command through the shell, its output kept until it ends. */
function run(label, command, env = {}) {
  const started = Date.now();
  return new Promise((resolve) => {
    const chunks = [];
    const child = spawn(command, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...colour, ...env },
    });
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    const finish = (code) => {
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const ok = code === 0;
      const output = Buffer.concat(chunks).toString().trimEnd();
      process.stdout.write(
        `== ${label}: ${ok ? "ok" : `FAILED (exit ${code})`} in ${seconds} s ==\n`,
      );
      if (output) process.stdout.write(`${output}\n\n`);
      resolve({ label, ok, seconds });
    };
    child.on("error", (error) => {
      chunks.push(Buffer.from(String(error)));
      finish(1);
    });
    child.on("close", (code) => finish(code ?? 1));
  });
}

const started = Date.now();
const treeBefore = treeHash();
// Same NODE_ENV as `nuxt typecheck` gives its own prepare.
const prepared = await run("nuxt prepare", PREPARE, {
  NODE_ENV: process.env.NODE_ENV || "production",
});
if (!prepared.ok) process.exit(1);

const results = [];
if (serial) {
  for (const step of STEPS) results.push(await run(step.label, step.command));
} else {
  results.push(
    ...(await Promise.all(STEPS.map((step) => run(step.label, step.command)))),
  );
}

const total = ((Date.now() - started) / 1000).toFixed(1);
const failed = results.filter((result) => !result.ok);
process.stdout.write(
  `${results.map((r) => `  ${r.ok ? "ok    " : "FAILED"} ${r.label} (${r.seconds} s)`).join("\n")}\n`,
);
if (failed.length > 0) {
  process.stdout.write(
    `verify failed in ${total} s: ${failed.map((r) => r.label).join(", ")}\n`,
  );
  process.exit(1);
}
process.stdout.write(`verify passed in ${total} s\n`);
if (treeBefore && treeHash() === treeBefore) {
  mkdirSync(dirname(VERIFIED_TREE_FILE), { recursive: true });
  writeFileSync(VERIFIED_TREE_FILE, `${treeBefore}\n`);
}
