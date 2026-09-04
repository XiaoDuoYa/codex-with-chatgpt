import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RUNTIME_DEPLOYMENT_INPUTS,
  RUNTIME_PACKAGE_INPUTS,
  installRuntime,
  runtimeCurrentPath,
  runtimeEntryPath,
  runtimeInstallationPath,
  runtimeLauncherPath,
  restoreRuntimeInstallation,
  snapshotRuntimeInstallation,
  type RuntimeCommandResult,
} from "../src/config/runtime-install.js";
import {
  computeContentDigest,
  readSourceMetadata,
  SOURCE_METADATA_FILENAME,
} from "../src/update/source-metadata.js";
import { isolatedGitEnvironment } from "../src/config/git-environment.js";
import { cleanup, git, makeTmpDir, write } from "./helpers.js";

const dirs: string[] = [];

function makeSource(version = "0.1.1", objectFormat?: "sha1" | "sha256"): string {
  const source = makeTmpDir("runtime-source");
  dirs.push(source);
  write(source, "package.json", JSON.stringify({ name: "codex-with-chatgpt", version }));
  write(source, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  write(source, "tsconfig.json", JSON.stringify({ compilerOptions: { outDir: "dist" }, include: ["src/**/*.ts"] }));
  write(source, "src/index.ts", "export const fixture = 1;\n");
  write(source, ".gitignore", "dist/\nnode_modules/\n");
  write(source, "bin/c2c.js", "#!/usr/bin/env node\n");
  fs.chmodSync(path.join(source, "bin/c2c.js"), 0o700);
  write(source, "dist/cli/index.js", `runtime ${version}\n`);
  write(source, "skill/SKILL.md", "# C2C\n");
  write(source, "docs/architecture.md", "# Architecture\n");
  write(source, "LICENSE", "MIT\n");
  write(source, "README.md", "# C2C\n");
  write(source, "README.zh-CN.md", "# C2C\n");
  git(source, "init", ...(objectFormat ? [`--object-format=${objectFormat}`] : []), "-b", "main");
  git(source, "add", ".");
  git(source, "commit", "-m", "runtime fixture");
  expect(RUNTIME_PACKAGE_INPUTS).toContain("pnpm-workspace.yaml");
  return source;
}

function successfulInstall() {
  return vi.fn((_command: string, args: string[], options: { cwd: string; timeoutMs: number }): RuntimeCommandResult => {
    expect(fs.existsSync(path.join(options.cwd, "package.json"))).toBe(true);
    if (args.includes("build")) {
      const packageJson = JSON.parse(fs.readFileSync(path.join(options.cwd, "package.json"), "utf8")) as { version: string };
      write(options.cwd, "dist/cli/index.js", `built runtime ${packageJson.version}\n`);
    }
    return { status: 0, stdout: "deployed", stderr: "" };
  });
}

afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
  vi.unstubAllEnvs();
});

describe("machine runtime installation", () => {
  it("clears Git environment names case-insensitively", () => {
    vi.stubEnv("git_dir", "/tmp/ambient-git-dir");
    vi.stubEnv("Git_Object_Directory", "/tmp/ambient-git-objects");

    const env = isolatedGitEnvironment();

    expect(env).not.toHaveProperty("git_dir");
    expect(env).not.toHaveProperty("Git_Object_Directory");
    expect(env).toMatchObject({ GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" });
  });

  it("computes an order-independent digest and records symlinks without following them", () => {
    const sourceRoot = makeSource();
    const link = path.join(sourceRoot, "docs-link");
    fs.symlinkSync("docs", link);

    const first = computeContentDigest(sourceRoot, ["docs", "bin"]);
    const reordered = computeContentDigest(sourceRoot, ["bin", "docs"]);
    const linkDigest = computeContentDigest(sourceRoot, ["docs-link"]);

    expect(reordered).toBe(first);
    expect(linkDigest).not.toBe(computeContentDigest(sourceRoot, ["docs"]));
  });

  it("uses the checkout production dependency bundle without pnpm metadata", () => {
    const stateRoot = makeTmpDir("runtime-bundled-state");
    const sourceRoot = makeSource();
    const homeDir = makeTmpDir("runtime-bundled-home");
    dirs.push(stateRoot, homeDir);
    write(
      sourceRoot,
      "package.json",
      JSON.stringify({
        name: "codex-with-chatgpt",
        version: "0.1.1",
        dependencies: { fixture: "1.0.0" },
      }),
    );
    git(sourceRoot, "add", "package.json");
    git(sourceRoot, "commit", "-m", "runtime dependency fixture");
    const runner = vi.fn((_command: string, args: string[], options: { cwd: string; timeoutMs: number }) => {
      if (args.includes("build")) write(options.cwd, "dist/cli/index.js", "built runtime 0.1.1\n");
      if (args.includes("--frozen-lockfile") && !args.includes("--prod")) {
        write(options.cwd, "node_modules/fixture/package.json", JSON.stringify({ name: "fixture", version: "1.0.0" }));
        write(options.cwd, "node_modules/fixture/index.js", "module.exports = 42;\n");
      }
      return { status: 0, stdout: "deployed", stderr: "" };
    });

    const result = installRuntime({ stateRoot, checkoutRoot: sourceRoot, homeDir, runner });

    expect(runner).toHaveBeenCalledTimes(2);
    expect(result.commands).toEqual([
      expect.objectContaining({ status: 0 }),
      expect.objectContaining({ status: 0 }),
      expect.objectContaining({
        status: 0,
        stdout: "production dependencies copied from checkout node_modules",
      }),
    ]);
    expect(result.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 0,
        stdout: "production dependencies copied from checkout node_modules",
      }),
    ]));
    expect(fs.readFileSync(path.join(runtimeCurrentPath(stateRoot), "node_modules/fixture/index.js"), "utf8")).toBe(
      "module.exports = 42;\n",
    );
  });

  it("deploys the built package with pnpm --prod and publishes a fixed current link", () => {
    const stateRoot = makeTmpDir("runtime-state");
    const sourceRoot = makeSource();
    const homeDir = makeTmpDir("runtime-home");
    dirs.push(stateRoot, homeDir);
    const sourcePackage = fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8");
    write(sourceRoot, "dist/cli/index.js", "tampered checkout artifact\n");
    const runner = successfulInstall();

    const result = installRuntime({ stateRoot, checkoutRoot: sourceRoot, homeDir, runner });

    expect(runner).toHaveBeenCalledWith(
      "corepack",
      ["pnpm", "install", "--prod", "--offline", "--frozen-lockfile", "--ignore-scripts"],
      { cwd: expect.stringContaining(`${path.sep}.stage-`), timeoutMs: expect.any(Number) },
    );
    expect(fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8")).toBe(sourcePackage);
    expect(result).toMatchObject({
      installed: true,
      changed: true,
      path: runtimeCurrentPath(stateRoot),
      entryPath: runtimeEntryPath(stateRoot),
      packageVersion: "0.1.1",
      launcherPath: runtimeLauncherPath(homeDir),
      launcherChanged: true,
    });
    expect(fs.lstatSync(runtimeCurrentPath(stateRoot)).isSymbolicLink()).toBe(true);
    expect(fs.statSync(runtimeEntryPath(stateRoot)).isFile()).toBe(true);
    expect(result.commands).toHaveLength(3);
    expect(fs.readdirSync(runtimeInstallationPath(stateRoot)).some((entry) => entry.startsWith(".stage-"))).toBe(true);
    expect(fs.realpathSync(runtimeLauncherPath(homeDir))).toBe(fs.realpathSync(runtimeEntryPath(stateRoot)));
    expect(fs.readFileSync(path.join(runtimeCurrentPath(stateRoot), "dist", "cli", "index.js"), "utf8")).toBe(
      "built runtime 0.1.1\n",
    );
    const metadata = readSourceMetadata(runtimeCurrentPath(stateRoot));
    expect(metadata?.contentDigest).toBe(computeContentDigest(runtimeCurrentPath(stateRoot), RUNTIME_DEPLOYMENT_INPUTS));
  });

  it("ignores ambient Git repository and index selection", () => {
    const stateRoot = makeTmpDir("runtime-git-env-state");
    const sourceRoot = makeSource();
    const otherRoot = makeSource("9.9.9");
    const homeDir = makeTmpDir("runtime-git-env-home");
    dirs.push(stateRoot, homeDir);
    const expectedRevision = git(sourceRoot, "rev-parse", "HEAD").trim();
    vi.stubEnv("GIT_DIR", path.join(otherRoot, ".git"));
    vi.stubEnv("GIT_WORK_TREE", otherRoot);
    vi.stubEnv("GIT_INDEX_FILE", path.join(otherRoot, ".git", "index"));
    vi.stubEnv("GIT_OBJECT_DIRECTORY", path.join(otherRoot, ".git", "objects"));
    vi.stubEnv("GIT_EXEC_PATH", path.join(otherRoot, "missing-git-exec-path"));

    installRuntime({ stateRoot, checkoutRoot: sourceRoot, homeDir, runner: successfulInstall() });

    expect(readSourceMetadata(runtimeCurrentPath(stateRoot))?.revision).toBe(expectedRevision);
    expect(JSON.parse(fs.readFileSync(path.join(runtimeCurrentPath(stateRoot), "package.json"), "utf8"))).toMatchObject({
      version: "0.1.1",
    });
  });

  it("reads tracked source with replace refs disabled", () => {
    const stateRoot = makeTmpDir("runtime-replace-state");
    const sourceRoot = makeSource();
    const homeDir = makeTmpDir("runtime-replace-home");
    dirs.push(stateRoot, homeDir);
    const originalRevision = git(sourceRoot, "rev-parse", "HEAD").trim();
    write(sourceRoot, "package.json", JSON.stringify({ name: "codex-with-chatgpt", version: "9.9.9" }));
    git(sourceRoot, "add", "package.json");
    git(sourceRoot, "commit", "-m", "replacement runtime");
    const replacementRevision = git(sourceRoot, "rev-parse", "HEAD").trim();
    git(sourceRoot, "checkout", "--detach", originalRevision);
    git(sourceRoot, "replace", originalRevision, replacementRevision);

    installRuntime({ stateRoot, checkoutRoot: sourceRoot, homeDir, runner: successfulInstall() });

    expect(readSourceMetadata(runtimeCurrentPath(stateRoot))?.revision).toBe(originalRevision);
    expect(JSON.parse(fs.readFileSync(path.join(runtimeCurrentPath(stateRoot), "package.json"), "utf8"))).toMatchObject({
      version: "0.1.1",
    });
  });

  it("reads blobs with replace refs disabled", () => {
    const stateRoot = makeTmpDir("runtime-blob-replace-state");
    const sourceRoot = makeSource();
    const homeDir = makeTmpDir("runtime-blob-replace-home");
    dirs.push(stateRoot, homeDir);
    const originalBlob = git(sourceRoot, "rev-parse", "HEAD:package.json").trim();
    const replacement = write(
      sourceRoot,
      ".git/replacement-package.json",
      JSON.stringify({ name: "codex-with-chatgpt", version: "9.9.9" }),
    );
    const replacementBlob = git(sourceRoot, "hash-object", "-w", replacement).trim();
    git(sourceRoot, "replace", originalBlob, replacementBlob);

    installRuntime({ stateRoot, checkoutRoot: sourceRoot, homeDir, runner: successfulInstall() });

    expect(JSON.parse(fs.readFileSync(path.join(runtimeCurrentPath(stateRoot), "package.json"), "utf8"))).toMatchObject({
      version: "0.1.1",
    });
  });

  it("supports Git repositories that use SHA-256 object ids", () => {
    const stateRoot = makeTmpDir("runtime-sha256-state");
    const sourceRoot = makeSource("0.1.1", "sha256");
    const homeDir = makeTmpDir("runtime-sha256-home");
    dirs.push(stateRoot, homeDir);
    const revision = git(sourceRoot, "rev-parse", "HEAD").trim();

    installRuntime({ stateRoot, checkoutRoot: sourceRoot, homeDir, runner: successfulInstall() });

    expect(revision).toMatch(/^[0-9a-f]{64}$/);
    expect(readSourceMetadata(runtimeCurrentPath(stateRoot))?.revision).toBe(revision);
  });

  it("uses the pinned revision when HEAD changes immediately before ls-tree", () => {
    const stateRoot = makeTmpDir("runtime-head-race-state");
    const sourceRoot = makeSource();
    const homeDir = makeTmpDir("runtime-head-race-home");
    dirs.push(stateRoot, homeDir);
    const originalRevision = git(sourceRoot, "rev-parse", "HEAD").trim();
    write(sourceRoot, "package.json", JSON.stringify({ name: "codex-with-chatgpt", version: "2.0.0" }));
    git(sourceRoot, "add", "package.json");
    git(sourceRoot, "commit", "-m", "next runtime");
    const nextRevision = git(sourceRoot, "rev-parse", "HEAD").trim();
    git(sourceRoot, "checkout", "--detach", originalRevision);
    const originalPath = process.env.PATH ?? "";
    const realGit = originalPath
      .split(path.delimiter)
      .map((directory) => path.join(directory, process.platform === "win32" ? "git.exe" : "git"))
      .find((candidate) => fs.existsSync(candidate));
    expect(realGit).toBeTruthy();
    const wrapperRoot = makeTmpDir("runtime-git-wrapper");
    dirs.push(wrapperRoot);
    const wrapper = write(wrapperRoot, "git", `#!/bin/sh
if [ "$1" = "ls-tree" ]; then
  "$C2C_TEST_REAL_GIT" -C "$C2C_TEST_SOURCE_ROOT" checkout --detach "$C2C_TEST_NEXT_REVISION" >/dev/null 2>&1 || exit 91
fi
exec "$C2C_TEST_REAL_GIT" "$@"
`);
    fs.chmodSync(wrapper, 0o700);
    vi.stubEnv("C2C_TEST_REAL_GIT", realGit!);
    vi.stubEnv("C2C_TEST_SOURCE_ROOT", sourceRoot);
    vi.stubEnv("C2C_TEST_NEXT_REVISION", nextRevision);
    vi.stubEnv("PATH", `${wrapperRoot}${path.delimiter}${originalPath}`);

    installRuntime({ stateRoot, checkoutRoot: sourceRoot, homeDir, runner: successfulInstall() });

    expect(git(sourceRoot, "rev-parse", "HEAD").trim()).toBe(nextRevision);
    expect(readSourceMetadata(runtimeCurrentPath(stateRoot))?.revision).toBe(originalRevision);
    expect(JSON.parse(fs.readFileSync(path.join(runtimeCurrentPath(stateRoot), "package.json"), "utf8"))).toMatchObject({
      version: "0.1.1",
    });
  });

  it("keeps the previous current runtime when deployment validation fails", () => {
    const stateRoot = makeTmpDir("runtime-rollback-state");
    const sourceRoot = makeSource("1.0.0");
    const homeDir = makeTmpDir("runtime-rollback-home");
    dirs.push(stateRoot, homeDir);
    const firstRunner = successfulInstall();
    installRuntime({ stateRoot, checkoutRoot: sourceRoot, homeDir, runner: firstRunner });
    const previousEntry = fs.readFileSync(runtimeEntryPath(stateRoot), "utf8");
    const runner = vi.fn((_command: string, args: string[], options: { cwd: string }): RuntimeCommandResult => {
      if (args.includes("build")) write(options.cwd, "dist/cli/index.js", "built runtime 1.0.0\n");
      if (options.cwd.includes(`${path.sep}.stage-`)) {
        fs.rmSync(path.join(options.cwd, "docs"), { recursive: true, force: true });
      }
      return { status: 0, stdout: "deployed", stderr: "" };
    });

    expect(() => installRuntime({ stateRoot, checkoutRoot: sourceRoot, homeDir, runner })).toThrow(/critical file/);
    expect(fs.readFileSync(runtimeEntryPath(stateRoot), "utf8")).toBe(previousEntry);
    expect(fs.lstatSync(runtimeCurrentPath(stateRoot)).isSymbolicLink()).toBe(true);
  });

  it("is idempotent without invoking pnpm when the process is already running from current", () => {
    const stateRoot = makeTmpDir("runtime-idempotent-state");
    const sourceRoot = makeSource();
    const homeDir = makeTmpDir("runtime-idempotent-home");
    dirs.push(stateRoot, homeDir);
    installRuntime({ stateRoot, checkoutRoot: sourceRoot, homeDir, runner: successfulInstall() });
    const runner = vi.fn(() => ({ status: 99, stdout: "", stderr: "must not run" }));

    const result = installRuntime({
      stateRoot,
      checkoutRoot: sourceRoot,
      homeDir,
      runningEntryPath: runtimeEntryPath(stateRoot),
      runner,
    });

    expect(result.changed).toBe(false);
    expect(result.packageVersion).toBe("0.1.1");
    expect(runner).not.toHaveBeenCalled();
  });

  it.each([
    ["built output", "dist/cli/index.js"],
    ["production dependencies", "node_modules/injected.js"],
  ])("rebuilds instead of reusing a runtime with tampered %s", (_label, relative) => {
    const stateRoot = makeTmpDir("runtime-tamper-state");
    const sourceRoot = makeSource();
    const homeDir = makeTmpDir("runtime-tamper-home");
    dirs.push(stateRoot, homeDir);
    installRuntime({ stateRoot, checkoutRoot: sourceRoot, homeDir, runner: successfulInstall() });
    write(runtimeCurrentPath(stateRoot), relative, "tampered\n");
    const runner = successfulInstall();

    const result = installRuntime({
      stateRoot,
      checkoutRoot: sourceRoot,
      homeDir,
      runningEntryPath: runtimeEntryPath(stateRoot),
      runner,
    });

    expect(result.changed).toBe(true);
    expect(runner).toHaveBeenCalled();
    expect(fs.readFileSync(path.join(runtimeCurrentPath(stateRoot), "dist/cli/index.js"), "utf8")).toBe(
      "built runtime 0.1.1\n",
    );
    expect(fs.existsSync(path.join(runtimeCurrentPath(stateRoot), "node_modules/injected.js"))).toBe(false);
  });

  it("recognizes a launch through the global c2c symlink as running from current", () => {
    const stateRoot = makeTmpDir("runtime-launcher-idempotent-state");
    const sourceRoot = makeSource();
    const homeDir = makeTmpDir("runtime-launcher-idempotent-home");
    dirs.push(stateRoot, homeDir);
    installRuntime({ stateRoot, checkoutRoot: sourceRoot, homeDir, runner: successfulInstall() });
    const runner = vi.fn(() => ({ status: 99, stdout: "", stderr: "must not run" }));

    const result = installRuntime({
      stateRoot,
      checkoutRoot: sourceRoot,
      homeDir,
      runningEntryPath: runtimeLauncherPath(homeDir),
      runner,
    });

    expect(result.changed).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });

  it("reinstalls a deployment whose metadata predates content digests", () => {
    const stateRoot = makeTmpDir("runtime-legacy-metadata-state");
    const sourceRoot = makeSource();
    const homeDir = makeTmpDir("runtime-legacy-metadata-home");
    dirs.push(stateRoot, homeDir);
    installRuntime({ stateRoot, checkoutRoot: sourceRoot, homeDir, runner: successfulInstall() });

    const metadataFile = path.join(runtimeCurrentPath(stateRoot), SOURCE_METADATA_FILENAME);
    const legacyMetadata = JSON.parse(fs.readFileSync(metadataFile, "utf8")) as Record<string, unknown>;
    delete legacyMetadata.contentDigest;
    fs.writeFileSync(metadataFile, JSON.stringify(legacyMetadata));
    expect(readSourceMetadata(runtimeCurrentPath(stateRoot))).toBeNull();

    const runner = successfulInstall();
    const result = installRuntime({
      stateRoot,
      checkoutRoot: sourceRoot,
      homeDir,
      runningEntryPath: runtimeEntryPath(stateRoot),
      runner,
    });
    expect(result.changed).toBe(true);
    expect(runner).toHaveBeenCalledTimes(3);
    expect(readSourceMetadata(runtimeCurrentPath(stateRoot))?.contentDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects an unsafe current link outside the machine installation", () => {
    const stateRoot = makeTmpDir("runtime-link-state");
    const sourceRoot = makeSource();
    dirs.push(stateRoot);
    const installation = runtimeInstallationPath(stateRoot);
    fs.mkdirSync(installation, { recursive: true });
    fs.symlinkSync(sourceRoot, runtimeCurrentPath(stateRoot), "dir");

    expect(() => installRuntime({ stateRoot, checkoutRoot: sourceRoot, runner: successfulInstall() })).toThrow(
      /outside the installation/,
    );
  });

  it("rejects an unrelated launcher file instead of reporting a usable installation", () => {
    const stateRoot = makeTmpDir("runtime-launcher-file-state");
    const sourceRoot = makeSource();
    const homeDir = makeTmpDir("runtime-launcher-file-home");
    dirs.push(stateRoot, homeDir);
    const launcher = runtimeLauncherPath(homeDir);
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    fs.writeFileSync(launcher, "user launcher\n");

    expect(() =>
      installRuntime({ stateRoot, checkoutRoot: sourceRoot, homeDir, runner: successfulInstall() }),
    ).toThrow(/unmanaged file/);

    expect(fs.readFileSync(launcher, "utf8")).toBe("user launcher\n");
    expect(fs.existsSync(runtimeCurrentPath(stateRoot))).toBe(false);
  });

  it("rejects an unrelated launcher symlink without replacing its target", () => {
    const stateRoot = makeTmpDir("runtime-launcher-link-state");
    const sourceRoot = makeSource();
    const homeDir = makeTmpDir("runtime-launcher-link-home");
    const unrelated = makeTmpDir("runtime-launcher-link-target");
    dirs.push(stateRoot, homeDir, unrelated);
    const launcher = runtimeLauncherPath(homeDir);
    const unrelatedEntry = path.join(unrelated, "c2c.js");
    fs.writeFileSync(unrelatedEntry, "unrelated launcher\n");
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    fs.symlinkSync(unrelatedEntry, launcher);

    expect(() =>
      installRuntime({ stateRoot, checkoutRoot: sourceRoot, homeDir, runner: successfulInstall() }),
    ).toThrow(/unmanaged symlink/);

    expect(fs.realpathSync(launcher)).toBe(fs.realpathSync(unrelatedEntry));
    expect(fs.readFileSync(unrelatedEntry, "utf8")).toBe("unrelated launcher\n");
    expect(fs.existsSync(runtimeCurrentPath(stateRoot))).toBe(false);
  });

  it("updates a launcher that still points at the old checkout", () => {
    const stateRoot = makeTmpDir("runtime-old-launcher-state");
    const sourceRoot = makeSource();
    const homeDir = makeTmpDir("runtime-old-launcher-home");
    dirs.push(stateRoot, homeDir);
    const launcher = runtimeLauncherPath(homeDir);
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    fs.symlinkSync(path.join(sourceRoot, "bin", "c2c.js"), launcher);

    const result = installRuntime({ stateRoot, checkoutRoot: sourceRoot, homeDir, runner: successfulInstall() });

    expect(result.launcherChanged).toBe(true);
    expect(fs.realpathSync(launcher)).toBe(fs.realpathSync(runtimeEntryPath(stateRoot)));
  });

  it("restores the previous current runtime and launcher after a setup rollback", () => {
    const stateRoot = makeTmpDir("runtime-transaction-state");
    const firstSource = makeSource("1.0.0");
    const secondSource = makeSource("2.0.0");
    const homeDir = makeTmpDir("runtime-transaction-home");
    dirs.push(stateRoot, homeDir);
    installRuntime({ stateRoot, checkoutRoot: firstSource, homeDir, runner: successfulInstall() });
    const snapshot = snapshotRuntimeInstallation({ stateRoot, homeDir });

    installRuntime({ stateRoot, checkoutRoot: secondSource, homeDir, runner: successfulInstall() });
    expect(fs.readFileSync(path.join(runtimeCurrentPath(stateRoot), "dist", "cli", "index.js"), "utf8")).toContain("2.0.0");

    restoreRuntimeInstallation(snapshot);
    expect(fs.readFileSync(path.join(runtimeCurrentPath(stateRoot), "dist", "cli", "index.js"), "utf8")).toContain("1.0.0");
    expect(fs.realpathSync(runtimeLauncherPath(homeDir))).toBe(fs.realpathSync(runtimeEntryPath(stateRoot)));
  });

  it("restores an initially absent current runtime and launcher", () => {
    const stateRoot = makeTmpDir("runtime-transaction-empty-state");
    const sourceRoot = makeSource();
    const homeDir = makeTmpDir("runtime-transaction-empty-home");
    dirs.push(stateRoot, homeDir);
    const snapshot = snapshotRuntimeInstallation({ stateRoot, homeDir });

    installRuntime({ stateRoot, checkoutRoot: sourceRoot, homeDir, runner: successfulInstall() });
    restoreRuntimeInstallation(snapshot);
    expect(fs.existsSync(runtimeCurrentPath(stateRoot))).toBe(false);
    expect(fs.existsSync(runtimeLauncherPath(homeDir))).toBe(false);
  });

  it("keeps the published current runtime when atomic rollback publication fails", () => {
    const stateRoot = makeTmpDir("runtime-current-publication-failure-state");
    const firstSource = makeSource("1.0.0");
    const secondSource = makeSource("2.0.0");
    const homeDir = makeTmpDir("runtime-current-publication-failure-home");
    dirs.push(stateRoot, homeDir);
    installRuntime({ stateRoot, checkoutRoot: firstSource, homeDir, runner: successfulInstall() });
    const snapshot = snapshotRuntimeInstallation({ stateRoot, homeDir });
    installRuntime({ stateRoot, checkoutRoot: secondSource, homeDir, runner: successfulInstall() });
    const current = runtimeCurrentPath(stateRoot);
    const publishedTarget = fs.realpathSync(current);
    const originalRename = fs.renameSync.bind(fs);
    let injected = false;
    vi.spyOn(fs, "renameSync").mockImplementation(((source, target) => {
      if (
        !injected &&
        path.resolve(String(target)) === current &&
        path.basename(String(source)).startsWith(".current.rollback-")
      ) {
        injected = true;
        throw new Error("simulated current publication failure");
      }
      return originalRename(source, target);
    }) as typeof fs.renameSync);

    expect(() => restoreRuntimeInstallation(snapshot)).toThrow(/current publication failure/);
    expect(injected).toBe(true);
    expect(fs.realpathSync(current)).toBe(publishedTarget);
    expect(fs.readFileSync(path.join(current, "dist/cli/index.js"), "utf8")).toContain("2.0.0");
  });

  it("keeps the existing launcher when atomic file restoration fails", () => {
    const stateRoot = makeTmpDir("runtime-launcher-publication-failure-state");
    const sourceRoot = makeSource();
    const homeDir = makeTmpDir("runtime-launcher-publication-failure-home");
    dirs.push(stateRoot, homeDir);
    installRuntime({ stateRoot, checkoutRoot: sourceRoot, homeDir, runner: successfulInstall() });
    const launcher = runtimeLauncherPath(homeDir);
    fs.unlinkSync(launcher);
    fs.writeFileSync(launcher, "legacy launcher\n", { mode: 0o744 });
    const snapshot = snapshotRuntimeInstallation({ stateRoot, homeDir });
    fs.unlinkSync(launcher);
    fs.symlinkSync(runtimeEntryPath(stateRoot), launcher);
    const existingTarget = fs.realpathSync(launcher);
    const originalRename = fs.renameSync.bind(fs);
    let injected = false;
    vi.spyOn(fs, "renameSync").mockImplementation(((source, target) => {
      if (
        !injected &&
        path.resolve(String(target)) === launcher &&
        path.basename(String(source)).startsWith(".c2c.rollback-")
      ) {
        injected = true;
        throw new Error("simulated launcher publication failure");
      }
      return originalRename(source, target);
    }) as typeof fs.renameSync);

    expect(() => restoreRuntimeInstallation(snapshot)).toThrow(/launcher publication failure/);
    expect(injected).toBe(true);
    expect(fs.lstatSync(launcher).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(launcher)).toBe(existingTarget);
  });
});
