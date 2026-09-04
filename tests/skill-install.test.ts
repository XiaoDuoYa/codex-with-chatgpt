import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installGlobalSkill,
  restoreGlobalSkill,
  renderSkill,
  snapshotGlobalSkill,
  statusGlobalSkill,
} from "../src/config/skill-install.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const cliEntry = path.join(projectRoot, "src", "cli", "index.ts");
const temporaryDirectories: string[] = [];

function tempDir(name: string): string {
  const dir = makeTmpDir(name);
  temporaryDirectories.push(dir);
  return dir;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) cleanup(temporaryDirectories.pop()!);
});

describe("global Skill installation", () => {
  it("renders the checkout path and installs idempotently with owner-only permissions", () => {
    const checkoutRoot = tempDir("skill-source");
    const codexHome = tempDir("skill-codex-home");
    const source = write(checkoutRoot, "skill/SKILL.md", "root=<ACTUAL_CHECKOUT_PATH>\n");

    const first = installGlobalSkill({ checkoutRoot, codexHome });
    const target = path.join(codexHome, "skills", "codex-with-chatgpt", "SKILL.md");
    expect(first).toMatchObject({ installed: true, changed: true, path: target });
    expect(fs.readFileSync(target, "utf8")).toBe(`root=${checkoutRoot}\n`);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);

    const second = installGlobalSkill({ checkoutRoot, codexHome });
    expect(second).toMatchObject({ installed: true, changed: false, contentHash: first.contentHash });
    expect(statusGlobalSkill({ checkoutRoot, codexHome })).toMatchObject({
      installed: true,
      matches: true,
      contentHash: first.contentHash,
      expectedContentHash: first.contentHash,
    });
    expect(source).toBe(path.join(checkoutRoot, "skill", "SKILL.md"));
  });

  it("rejects missing or duplicate checkout placeholders", () => {
    expect(() => renderSkill("no placeholder", "/checkout")).toThrow(/exactly one/);
    expect(() => renderSkill("<ACTUAL_CHECKOUT_PATH> <ACTUAL_CHECKOUT_PATH>", "/checkout")).toThrow(
      /2 .*placeholders/,
    );
  });

  it("rejects a symlink target instead of replacing it", () => {
    const checkoutRoot = tempDir("skill-symlink-source");
    const codexHome = tempDir("skill-symlink-home");
    write(checkoutRoot, "skill/SKILL.md", "<ACTUAL_CHECKOUT_PATH>\n");
    const targetDir = path.join(codexHome, "skills", "codex-with-chatgpt");
    fs.mkdirSync(targetDir, { recursive: true });
    const outside = write(tempDir("skill-symlink-outside"), "SKILL.md", "outside\n");
    fs.symlinkSync(outside, path.join(targetDir, "SKILL.md"));

    expect(() => installGlobalSkill({ checkoutRoot, codexHome })).toThrow(/symlink/);
    expect(fs.readFileSync(outside, "utf8")).toBe("outside\n");
  });

  it("reports an absent target without creating the global directory", () => {
    const checkoutRoot = tempDir("skill-status-source");
    const codexHome = path.join(tempDir("skill-status-parent"), "missing-codex-home");
    write(checkoutRoot, "skill/SKILL.md", "<ACTUAL_CHECKOUT_PATH>\n");

    const status = statusGlobalSkill({ checkoutRoot, codexHome });
    expect(status).toMatchObject({ installed: false, matches: false, contentHash: null });
    expect(fs.existsSync(codexHome)).toBe(false);
  });

  it("restores the previous global Skill after a setup rollback", () => {
    const firstCheckout = tempDir("skill-transaction-first");
    const secondCheckout = tempDir("skill-transaction-second");
    const codexHome = tempDir("skill-transaction-home");
    write(firstCheckout, "skill/SKILL.md", "first=<ACTUAL_CHECKOUT_PATH>\n");
    write(secondCheckout, "skill/SKILL.md", "second=<ACTUAL_CHECKOUT_PATH>\n");

    installGlobalSkill({ checkoutRoot: firstCheckout, codexHome });
    const snapshot = snapshotGlobalSkill({ codexHome });
    installGlobalSkill({ checkoutRoot: secondCheckout, codexHome });
    expect(fs.readFileSync(snapshot.path, "utf8")).toContain("second=");

    restoreGlobalSkill(snapshot);
    expect(fs.readFileSync(snapshot.path, "utf8")).toBe(`first=${firstCheckout}\n`);
  });

  it("installs through the CLI under an isolated CODEX_HOME", () => {
    const codexHome = tempDir("skill-cli-home");
    const stateDir = tempDir("skill-cli-state");
    const result = spawnSync(process.execPath, ["--import", "tsx/esm", cliEntry, "skill", "install", "--json"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: { ...process.env, HOME: codexHome, CODEX_HOME: codexHome, C2C_STATE_DIR: stateDir },
      timeout: 20_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(payload).toMatchObject({ ok: true, installed: true, changed: true });
    expect(String(payload.path)).toContain(path.join(codexHome, "skills", "codex-with-chatgpt"));
    expect(JSON.stringify(payload)).not.toContain("runtimeKey");

    const installedSkill = fs.readFileSync(String(payload.path), "utf8");
    expect(installedSkill).toContain("c2c update-check -w <workspace-root> --json");
    expect(installedSkill).toContain("c2c sandbox-clean --json");
    expect(installedSkill).toContain("<git-common-dir>/codex-with-chatgpt");
    expect(installedSkill).toContain("<workspace-root>/.codex-with-chatgpt");
    expect(installedSkill).not.toContain("c2c sandbox-allow");
  });
});
