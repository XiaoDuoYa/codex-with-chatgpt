import { afterEach, describe, expect, it } from "vitest";
import { validatePublishSet, type PublishChange } from "../src/github/security.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const roots: string[] = [];
const workspace = (): string => {
  const root = makeTmpDir("github-security");
  roots.push(root);
  return root;
};

afterEach(() => roots.splice(0).forEach(cleanup));

describe("validatePublishSet", () => {
  it("blocks a modified tracked sensitive file", () => {
    const result = validatePublishSet(workspace(), [{ path: ".env.production", status: "modified" }]);
    expect(result).toMatchObject({ ok: false, code: "SENSITIVE_FILE_BLOCKED" });
  });

  it("blocks a rename into a sensitive target but allows sensitive deletion", () => {
    expect(
      validatePublishSet(workspace(), [
        { path: ".env.production", originalPath: "safe.txt", status: "renamed" },
      ])
    ).toMatchObject({ ok: false, code: "SENSITIVE_FILE_BLOCKED" });
    expect(validatePublishSet(workspace(), [{ path: ".env.production", status: "deleted" }])).toMatchObject({ ok: true });
  });

  it("blocks conflicted and unrelated dirty files", () => {
    const changes: PublishChange[] = [
      { path: "src/allowed.ts", status: "modified" },
      { path: "src/conflict.ts", status: "conflicted" },
    ];
    expect(validatePublishSet(workspace(), changes, { declaredPaths: ["src/allowed.ts", "src/conflict.ts"] })).toMatchObject({
      ok: false,
      code: "CONFLICTED_FILES",
    });
    expect(
      validatePublishSet(workspace(), [{ path: "src/unrelated.ts", status: "modified" }], {
        declaredPaths: ["src/allowed.ts"],
      })
    ).toMatchObject({ ok: false, code: "UNRELATED_DIRTY_FILES" });
  });

  it("ignores ignored untracked entries and accepts explicit declared files", () => {
    expect(
      validatePublishSet(
        workspace(),
        [
          { path: "dist/output.js", status: "ignored" },
          { path: "src/allowed.ts", status: "modified" },
        ],
        { declaredPaths: ["src/allowed.ts"] }
      )
    ).toEqual({ ok: true, paths: ["src/allowed.ts"] });
  });

  it("refuses publication on main and master", () => {
    for (const branch of ["main", "master"]) {
      expect(
        validatePublishSet(workspace(), [{ path: "src/allowed.ts", status: "modified" }], {
          declaredPaths: ["src/allowed.ts"],
          branch,
        })
      ).toMatchObject({ ok: false, code: "PROTECTED_BRANCH" });
    }
  });
});
