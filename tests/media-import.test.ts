import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importMediaAsset } from "../src/media/import.js";
import { cleanup, makeGitRepo, makeTmpDir } from "./helpers.js";

describe("media asset import", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
  });

  function fixture(): { root: string; downloads: string } {
    const root = makeTmpDir("media-workspace");
    const downloads = makeTmpDir("media-downloads");
    dirs.push(root, downloads);
    makeGitRepo(root);
    return { root, downloads };
  }

  it("validates and copies a PNG into a new project-relative path", async () => {
    const { root, downloads } = fixture();
    const source = path.join(downloads, "generated.png");
    fs.writeFileSync(source, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
    const result = await importMediaAsset({ workspaceRoot: root, sourcePath: source, destinationPath: "public/hero.png" });
    expect(result.destinationPath).toBe("public/hero.png");
    expect(result.mediaType).toBe("image/png");
    expect(fs.existsSync(path.join(root, "public/hero.png"))).toBe(true);
    expect(fs.existsSync(source)).toBe(true);
  });

  it("refuses traversal, overwrite, spoofed media, and active SVG", async () => {
    const { root, downloads } = fixture();
    const fake = path.join(downloads, "fake.png");
    fs.writeFileSync(fake, "not png");
    await expect(importMediaAsset({ workspaceRoot: root, sourcePath: fake, destinationPath: "../fake.png" })).rejects.toThrow(/outside/i);
    await expect(importMediaAsset({ workspaceRoot: root, sourcePath: fake, destinationPath: "fake.png" })).rejects.toThrow(/does not match/);

    const svg = path.join(downloads, "unsafe.svg");
    fs.writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    await expect(importMediaAsset({ workspaceRoot: root, sourcePath: svg, destinationPath: "unsafe.svg" })).rejects.toThrow(/active/);

    const png = path.join(downloads, "ok.png");
    fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    fs.writeFileSync(path.join(root, "exists.png"), "keep");
    await expect(importMediaAsset({ workspaceRoot: root, sourcePath: png, destinationPath: "exists.png" })).rejects.toThrow(/already exists/);
  });
});
