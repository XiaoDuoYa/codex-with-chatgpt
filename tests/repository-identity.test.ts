import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { runGit } from "../src/workspace/git.js";
import { inspectRepositoryIdentity, parseRepositoryTarget } from "../src/workspace/repository-identity.js";

vi.mock("../src/workspace/git.js", () => ({ runGit: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
afterEach(() => vi.resetAllMocks());

describe("repository identity", () => {
  it("parses HTTPS, SSH and resolved aliases without returning credentials", () => {
    const target = { host: "github.com", owner: "user", name: "repo" };
    for (const remote of ["https://user:SECRET@github.com/user/repo.git", "git@github.com:user/repo.git", "ssh://git@github.com/user/repo.git"]) {
      expect(parseRepositoryTarget(remote)).toEqual(target);
    }
    expect(parseRepositoryTarget("personal-git:user/repo.git", () => "github.com")).toEqual(target);
    for (const remote of ["/local/repo", "file:///local/repo", "https://github.com/user/repo?token=SECRET", "https://github.com/user/repo/extra", "--bad:user/repo"]) {
      expect(parseRepositoryTarget(remote)).toBeNull();
    }
  });

  function fixture(push: string, login = "personal", ownerType = "User") {
    const values: Record<string, string> = {
      "symbolic-ref --short HEAD": "feature",
      "config --get branch.feature.pushRemote": "fork",
      "remote get-url --all fork": "https://github.com/upstream/repo.git",
      "remote get-url --push --all fork": push,
      "var GIT_AUTHOR_IDENT": "Different Author <author@example.com> 123 +0800",
      "var GIT_COMMITTER_IDENT": "Local Committer <committer@example.com> 123 +0800",
    };
    vi.mocked(runGit).mockImplementation((_root, args) => ({ ok: args.join(" ") in values, stdout: values[args.join(" ")] ?? "", stderr: "", code: 0 }));
    vi.mocked(spawnSync).mockImplementation(((command: string, args: string[]) => {
      const stdout = command === "ssh" ? "hostname github.com\nidentityfile /private/key\n" :
        args.includes("user") ? JSON.stringify({ login, id: 123 }) : JSON.stringify({ ownerType, canRead: true });
      return { status: 0, stdout, stderr: "" };
    }) as typeof spawnSync);
  }

  it("uses the actual push remote and separates gh, author and transport identities", () => {
    fixture("personal-git:personal/repo.git");
    const identity = inspectRepositoryIdentity("/workspace");
    expect(identity).toMatchObject({ remote: "fork", target: { owner: "personal" }, accountStatus: "matched", ghActor: { login: "personal", id: "123" }, author: { name: "Different Author" }, gitTransportActor: "unknown" });
    expect(identity.fetchTargets[0]?.owner).toBe("upstream");
    expect(JSON.stringify(identity)).not.toContain("/private/key");
  });

  it("blocks a wrong personal actor but handles authorized organization repositories", () => {
    fixture("https://github.com/personal/repo.git", "wrong-account");
    expect(inspectRepositoryIdentity("/workspace").accountStatus).toBe("mismatch");
    fixture("https://github.com/company/repo.git", "employee", "Organization");
    expect(inspectRepositoryIdentity("/workspace").accountStatus).toBe("matched");
  });

  it("keeps ambiguous push targets and unsupported hosts unknown without credential probes", () => {
    fixture("https://github.com/personal/repo.git\nhttps://github.com/other/repo.git");
    expect(inspectRepositoryIdentity("/workspace").target).toBeNull();
    expect(spawnSync).not.toHaveBeenCalled();
    fixture("https://unknown.example/personal/repo.git");
    expect(inspectRepositoryIdentity("/workspace").ghActor).toBeNull();
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
