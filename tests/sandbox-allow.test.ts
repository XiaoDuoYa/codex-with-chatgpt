import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  ensureSandboxIsolation,
  filterWritableRoots,
  listWritableRoots,
  pathsEquivalent,
  restoreCodexConfig,
  snapshotCodexConfig,
  toTomlPath,
} from "../src/config/sandbox-allow.js";
import { cleanup, makeTmpDir } from "./helpers.js";

describe("sandbox isolation", () => {
  it("treats Windows slash variants as the same path", () => {
    expect(
      pathsEquivalent(
        "C:\\Users\\Ada\\AppData\\Local\\codex-with-chatgpt",
        "C:/Users/Ada/AppData/Local/codex-with-chatgpt",
      ),
    ).toBe(true);
    expect(
      pathsEquivalent(
        "C:/Users/Ada/AppData/Local/codex-with-chatgpt/",
        "c:\\users\\ada\\appdata\\local\\codex-with-chatgpt",
      ),
    ).toBe(true);
  });

  it("does not create global config or grant a writable root", () => {
    const dir = makeTmpDir("sandbox-missing");
    const configPath = path.join(dir, "config.toml");

    expect(
      ensureSandboxIsolation({ configPath, protectedStateRoot: path.join(dir, "state") }),
    ).toEqual({ alreadyIsolated: true, removedRoots: 0, configPath });
    expect(fs.existsSync(configPath)).toBe(false);
    cleanup(dir);
  });

  it("removes the machine state root and every obsolete workspace-data descendant", () => {
    const dir = makeTmpDir("sandbox-boundary");
    const stateRoot = path.join(dir, "state");
    const otherRoot = path.join(dir, "other");
    const configPath = path.join(dir, "config.toml");
    fs.writeFileSync(
      configPath,
      [
        "[sandbox_workspace_write]",
        "writable_roots = [",
        `  "${toTomlPath(stateRoot)}",`,
        `  "${toTomlPath(path.join(stateRoot, "workspace-data"))}",`,
        `  "${toTomlPath(path.join(stateRoot, "workspace-data", "workspace-a"))}",`,
        `  "${toTomlPath(otherRoot)}",`,
        "]",
        "",
      ].join("\n"),
    );

    const result = ensureSandboxIsolation({ configPath, protectedStateRoot: stateRoot });

    expect(result).toMatchObject({ alreadyIsolated: false, removedRoots: 3 });
    expect(listWritableRoots(fs.readFileSync(configPath, "utf8"))).toEqual([
      toTomlPath(otherRoot),
    ]);
    cleanup(dir);
  });

  it("preserves similarly prefixed and unrelated writable roots", () => {
    const dir = makeTmpDir("sandbox-prefix");
    const stateRoot = path.join(dir, "state");
    const sibling = path.join(dir, "state-other");
    const configPath = path.join(dir, "config.toml");
    fs.writeFileSync(
      configPath,
      `[sandbox_workspace_write]\nwritable_roots = ["${toTomlPath(sibling)}"]\n`,
    );

    const result = ensureSandboxIsolation({ configPath, protectedStateRoot: stateRoot });

    expect(result).toMatchObject({ alreadyIsolated: true, removedRoots: 0 });
    expect(listWritableRoots(fs.readFileSync(configPath, "utf8"))).toEqual([
      toTomlPath(sibling),
    ]);
    cleanup(dir);
  });

  it("filters roots without changing other tables", () => {
    const original = [
      'model = "gpt-5"',
      "",
      "[sandbox_workspace_write]",
      'writable_roots = ["/keep", "/remove"]',
      "",
      "[features]",
      "js_repl = true",
      "",
    ].join("\n");
    const next = filterWritableRoots(original, (root) => root !== "/remove");

    expect(listWritableRoots(next)).toEqual(["/keep"]);
    expect(next).toContain('model = "gpt-5"');
    expect(next).toContain("[features]\njs_repl = true");
  });

  it("parses quoted brackets, escapes, hashes, and multiline comments", () => {
    const bracketRoot = "/tmp/with-[x]-brackets";
    const escapedRoot = '/tmp/with-\\backslash-"quote';
    const hashRoot = "/tmp/with#hash";
    const original = [
      "[sandbox_workspace_write] # table comment",
      "writable_roots = [",
      `  ${JSON.stringify(bracketRoot)}, # bracket comment`,
      `  ${JSON.stringify(escapedRoot)}, # escaped quote comment`,
      `  ${JSON.stringify(hashRoot)}, # hash comment`,
      "]",
      "[features]",
      "js_repl = true",
      "",
    ].join("\n");

    expect(listWritableRoots(original)).toEqual([bracketRoot, escapedRoot, hashRoot]);
    const next = filterWritableRoots(original, (root) => root !== escapedRoot);

    expect(listWritableRoots(next)).toEqual([bracketRoot, hashRoot]);
    expect(next).toContain("# bracket comment");
    expect(next).toContain("# escaped quote comment");
    expect(next).toContain("# hash comment");
    expect(next).toContain("[features]\njs_repl = true");
  });

  it("fails closed for malformed TOML without changing the config", () => {
    const dir = makeTmpDir("sandbox-malformed");
    const stateRoot = path.join(dir, "state");
    const configPath = path.join(dir, "config.toml");
    const malformed = [
      "[sandbox_workspace_write]",
      `writable_roots = [${JSON.stringify(stateRoot)}`,
      "",
    ].join("\n");
    fs.writeFileSync(configPath, malformed);

    expect(() => listWritableRoots(malformed)).toThrow(/Invalid Codex config TOML/);
    expect(() => filterWritableRoots(malformed, () => true)).toThrow(/Invalid Codex config TOML/);
    expect(() => ensureSandboxIsolation({ configPath, protectedStateRoot: stateRoot })).toThrow(
      /Invalid Codex config TOML/,
    );
    expect(fs.readFileSync(configPath, "utf8")).toBe(malformed);
    cleanup(dir);
  });

  it("is idempotent after obsolete roots are removed", () => {
    const dir = makeTmpDir("sandbox-idempotent");
    const stateRoot = path.join(dir, "state");
    const configPath = path.join(dir, "config.toml");
    fs.writeFileSync(
      configPath,
      `[sandbox_workspace_write]\nwritable_roots = ["${toTomlPath(stateRoot)}"]\n`,
    );

    expect(ensureSandboxIsolation({ configPath, protectedStateRoot: stateRoot }).removedRoots).toBe(1);
    expect(ensureSandboxIsolation({ configPath, protectedStateRoot: stateRoot })).toMatchObject({
      alreadyIsolated: true,
      removedRoots: 0,
    });
    expect(listWritableRoots(fs.readFileSync(configPath, "utf8"))).toEqual([]);
    cleanup(dir);
  });

  it("rejects a symlinked Codex config", () => {
    const dir = makeTmpDir("sandbox-config-symlink");
    const target = path.join(dir, "target.toml");
    const configPath = path.join(dir, "config.toml");
    fs.writeFileSync(target, "");
    fs.symlinkSync(target, configPath);

    expect(() =>
      ensureSandboxIsolation({ configPath, protectedStateRoot: path.join(dir, "state") }),
    ).toThrow(/regular file/);
    cleanup(dir);
  });

  it("restores an existing Codex config after a failed setup transaction", () => {
    const dir = makeTmpDir("sandbox-rollback-existing");
    const stateRoot = path.join(dir, "state");
    const configPath = path.join(dir, "config.toml");
    const original = `[sandbox_workspace_write]\nwritable_roots = ["${toTomlPath(stateRoot)}"]\n`;
    fs.writeFileSync(configPath, original, { mode: 0o600 });
    const snapshot = snapshotCodexConfig(configPath);

    ensureSandboxIsolation({ configPath, protectedStateRoot: stateRoot });
    restoreCodexConfig(snapshot);

    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    cleanup(dir);
  });

  it("keeps a missing Codex config missing across snapshot and restore", () => {
    const dir = makeTmpDir("sandbox-rollback-missing");
    const configPath = path.join(dir, "config.toml");
    const snapshot = snapshotCodexConfig(configPath);

    ensureSandboxIsolation({ configPath, protectedStateRoot: path.join(dir, "state") });
    restoreCodexConfig(snapshot);

    expect(fs.existsSync(configPath)).toBe(false);
    cleanup(dir);
  });
});
