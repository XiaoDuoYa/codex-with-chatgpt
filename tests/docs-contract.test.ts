import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { VERSION } from "../src/version.js";

const read = (file: string): string => fs.readFileSync(path.resolve(file), "utf8");

describe("V0.2 documentation contracts", () => {
  it("documents the Plus GitHub task flow without Developer Mode", () => {
    for (const file of ["README.md", "README.zh-CN.md", "skill/SKILL.md"]) {
      const text = read(file);
      expect(text).toContain("task start");
      expect(text).toContain("--transport github");
      const plusSection = text.split("PLUS FLOW START")[1]?.split("PLUS FLOW END")[0] ?? "";
      expect(plusSection).not.toMatch(/Developer Mode|开发人员模式/);
    }
  });

  it("keeps MCP setup and pairing as a supported path", () => {
    const combined = `${read("README.md")}\n${read("skill/SKILL.md")}`;
    expect(combined).toContain("c2c setup");
    expect(combined).toMatch(/pairing|配对/i);
  });

  it("describes FilePack only as future work", () => {
    const combined = ["README.md", "README.zh-CN.md", "docs/architecture.md"].map(read).join("\n");
    expect(combined).toContain("FilePack");
    expect(combined).not.toMatch(/c2c\s+(?:task\s+)?filepack/i);
  });

  it("documents pending DONE, blockedFrom, and the JSON truth boundary", () => {
    const protocol = read("docs/protocol.md");
    expect(protocol).toContain("pendingDecision");
    expect(protocol).toContain("blockedFrom");
    expect(protocol).toContain(".c2c/current.json");
    expect(protocol).toContain(".c2c/current.md");
  });

  it("keeps package and runtime versions aligned at 0.2.0", () => {
    const pkg = JSON.parse(read("package.json")) as { version: string };
    expect(VERSION).toBe("0.2.0");
    expect(pkg.version).toBe(VERSION);
  });
});
