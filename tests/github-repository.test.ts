import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { GitHubRepository, GitHubRepositoryError, parseGitHubRemote } from "../src/github/repository.js";
import { cleanup, git, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const roots: string[] = [];
const temp = (name: string): string => {
  const root = makeTmpDir(name);
  roots.push(root);
  return root;
};

afterEach(() => roots.splice(0).forEach(cleanup));

describe("parseGitHubRemote", () => {
  it("parses HTTPS and SSH GitHub remotes", () => {
    expect(parseGitHubRemote("https://github.com/acme/widget.git")).toEqual({ owner: "acme", name: "widget" });
    expect(parseGitHubRemote("git@github.com:acme/widget.git")).toEqual({ owner: "acme", name: "widget" });
    expect(parseGitHubRemote("ssh://git@github.com/acme/widget.git")).toEqual({ owner: "acme", name: "widget" });
    expect(parseGitHubRemote("https://example.com/acme/widget.git")).toBeNull();
  });
});

describe("GitHubRepository", () => {
  it("reports a missing remote and detached HEAD with structured errors", () => {
    const root = temp("github-inspect");
    makeGitRepo(root);
    const repository = new GitHubRepository(root);
    expect(() => repository.inspect("origin")).toThrowError(GitHubRepositoryError);
    try {
      repository.inspect("origin");
    } catch (error) {
      expect((error as GitHubRepositoryError).code).toBe("REMOTE_NOT_FOUND");
    }

    git(root, "checkout", "--detach");
    try {
      repository.inspect("origin");
    } catch (error) {
      expect((error as GitHubRepositoryError).code).toBe("DETACHED_HEAD");
    }
  });

  it("creates a task branch and commits only explicit paths", () => {
    const root = temp("github-commit");
    makeGitRepo(root);
    git(root, "config", "user.name", "c2c-test");
    git(root, "config", "user.email", "test@c2c.local");
    const repository = new GitHubRepository(root);
    const base = repository.fullHead();
    repository.createTaskBranch("c2c/c2c-11111111-test", base);
    write(root, "declared.txt", "declared\n");
    write(root, "hello.txt", "unrelated\n");
    repository.stagePaths(["declared.txt"]);
    const commit = repository.commit("test: explicit path");

    expect(commit).toMatch(/^[a-f0-9]{40}$/);
    expect(git(root, "show", "--name-only", "--format=", commit)).toContain("declared.txt");
    expect(git(root, "show", "--name-only", "--format=", commit)).not.toContain("hello.txt");
    expect(fs.readFileSync(path.join(root, "hello.txt"), "utf8")).toBe("unrelated\n");
  });

  it("pushes normally to a bare remote", () => {
    const root = temp("github-push");
    const bare = temp("github-bare");
    makeGitRepo(root);
    git(bare, "init", "--bare");
    git(root, "remote", "add", "origin", bare);
    const repository = new GitHubRepository(root);
    const base = repository.fullHead();
    repository.createTaskBranch("c2c/c2c-22222222-push", base);
    repository.push("origin", "c2c/c2c-22222222-push", true);

    expect(git(bare, "show-ref", "--verify", "refs/heads/c2c/c2c-22222222-push")).toContain(base);
  });

  it("returns a structured push failure", () => {
    const root = temp("github-push-fail");
    makeGitRepo(root);
    git(root, "remote", "add", "origin", path.join(root, "missing-remote.git"));
    const repository = new GitHubRepository(root);
    try {
      repository.push("origin", "main", false);
      expect.unreachable("push should fail");
    } catch (error) {
      expect((error as GitHubRepositoryError).code).toBe("PUBLISH_FAILED");
    }
  });
});
