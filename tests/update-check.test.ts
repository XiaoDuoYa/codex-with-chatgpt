import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkGitUpdate } from "../src/update/check.js";
import {
  installRuntime,
  runtimeCurrentPath,
} from "../src/config/runtime-install.js";
import { readSourceMetadata } from "../src/update/source-metadata.js";
import { cleanup, git, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    cleanup(temporaryDirectories.pop()!);
  }
});

function createRemoteFixture(): { local: string; remote: string } {
  const root = makeTmpDir();
  temporaryDirectories.push(root);
  const local = path.join(root, "local");
  const remote = path.join(root, "remote.git");
  fs.mkdirSync(local);
  fs.mkdirSync(remote);
  makeGitRepo(local);
  git(remote, "init", "--bare", "-b", "main");
  git(local, "remote", "add", "origin", remote);
  git(local, "push", "-u", "origin", "main");
  return { local, remote };
}

describe("checkGitUpdate", () => {
  it("reports no update when local and remote commits match", () => {
    const { local } = createRemoteFixture();

    expect(checkGitUpdate(local)).toMatchObject({ updateAvailable: false });
  });

  it("does not report an update when the local checkout is ahead", () => {
    const { local } = createRemoteFixture();
    write(local, "local-only.txt", "new local work\n");
    git(local, "add", "local-only.txt");
    git(local, "commit", "-m", "local commit");

    expect(checkGitUpdate(local)).toMatchObject({ updateAvailable: false });
  });

  it("reports an update when the remote has a commit missing locally", () => {
    const { local, remote } = createRemoteFixture();
    const publisher = path.join(path.dirname(local), "publisher");
    git(path.dirname(local), "clone", remote, publisher);
    write(publisher, "remote-only.txt", "new remote work\n");
    git(publisher, "add", "remote-only.txt");
    git(publisher, "commit", "-m", "remote commit");
    git(publisher, "push", "origin", "main");

    expect(checkGitUpdate(local)).toMatchObject({ updateAvailable: true });
  });

  it("checks an installed non-git runtime from source metadata", () => {
    const root = makeTmpDir("installed-update");
    temporaryDirectories.push(root);
    const source = path.join(root, "source");
    const remote = path.join(root, "remote.git");
    const stateRoot = path.join(root, "state");
    const homeDir = path.join(root, "home");
    fs.mkdirSync(source);
    makeGitRepo(source);
    write(source, "package.json", JSON.stringify({ name: "codex-with-chatgpt", version: "0.1.1" }));
    write(source, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    write(source, "tsconfig.json", JSON.stringify({ compilerOptions: { outDir: "dist" }, include: ["src/**/*.ts"] }));
    write(source, "bin/c2c.js", "#!/usr/bin/env node\n");
    write(source, "dist/cli/index.js", "runtime\n");
    write(source, "skill/SKILL.md", "# C2C\n");
    write(source, "docs/architecture.md", "# Architecture\n");
    write(source, "LICENSE", "MIT\n");
    write(source, "README.md", "# C2C\n");
    write(source, "README.zh-CN.md", "# C2C\n");
    git(source, "add", ".");
    git(source, "commit", "-m", "runtime source");
    fs.mkdirSync(remote);
    git(remote, "init", "--bare", "-b", "main");
    git(source, "remote", "add", "origin", `file://${remote}`);
    git(source, "push", "-u", "origin", "main");
    git(source, "checkout", "-b", "codex/temporary");

    const runner = (_command: string, args: string[], options: { cwd: string }) => {
      if (args.includes("build")) write(options.cwd, "dist/cli/index.js", "runtime\n");
      return { status: 0, stdout: "deployed", stderr: "" };
    };
    installRuntime({ stateRoot, checkoutRoot: source, homeDir, runner });
    const installed = runtimeCurrentPath(stateRoot);
    const metadata = readSourceMetadata(installed);
    expect(fs.existsSync(path.join(installed, ".git"))).toBe(false);
    expect(metadata).toMatchObject({
      revision: expect.stringMatching(/^[a-f0-9]{40}$/),
      repository: `file://${remote}`,
      ref: "refs/heads/main",
      baselineRemoteRevision: expect.stringMatching(/^[a-f0-9]{40}$/),
      contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(checkGitUpdate(installed)).toMatchObject({ updateAvailable: false });

    write(source, "dirty-only.txt", "must not be published\n");
    expect(() => installRuntime({ stateRoot, checkoutRoot: source, homeDir, runner })).toThrow(
      /source checkout must be clean/,
    );
    expect(fs.readFileSync(path.join(installed, "dist", "cli", "index.js"), "utf8")).toBe("runtime\n");
    fs.rmSync(path.join(source, "dirty-only.txt"));

    write(source, "local-only.txt", "local ahead\n");
    git(source, "add", "local-only.txt");
    git(source, "commit", "-m", "local ahead");
    installRuntime({ stateRoot, checkoutRoot: source, homeDir, runner });
    expect(checkGitUpdate(runtimeCurrentPath(stateRoot))).toMatchObject({ updateAvailable: false });

    const publisher = path.join(root, "publisher");
    git(root, "clone", remote, publisher);
    write(publisher, "remote-only.txt", "new remote work\n");
    git(publisher, "add", "remote-only.txt");
    git(publisher, "commit", "-m", "remote update");
    git(publisher, "push", "origin", "main");
    expect(checkGitUpdate(runtimeCurrentPath(stateRoot))).toMatchObject({ updateAvailable: true });
  });
});
