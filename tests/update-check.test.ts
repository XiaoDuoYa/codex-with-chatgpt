import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkGitUpdate } from "../src/update/check.js";
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
});
