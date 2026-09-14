import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  mergeUiPrefs,
  prefsFile,
  readUiPrefs,
  SETUP_CHOICE_PROMPT,
} from "../src/config/ui-prefs.js";
import { cleanup, isolateStateDir } from "./helpers.js";

describe("ui prefs", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("starts empty and is not bound to a workspace", () => {
    dirs.push(isolateStateDir());
    const prefs = readUiPrefs();
    expect(prefs.developerModeEnabled).toBe(false);
    expect(prefs.setupMode).toBeNull();
    expect(prefs.browserMode).toBe("in-app");
    expect(prefs.remembered).toEqual({ developerMode: false, setupMode: false, browserMode: false });
    expect(prefs.setupChoicePrompt).toBe(SETUP_CHOICE_PROMPT);
    expect(prefs.setupChoicePrompt).toContain("AI 自动化配置（预览版）");
    expect(prefs.setupChoicePrompt).toContain("手动教学配置");
    expect(prefs.setupChoicePrompt).toContain("请回复「1」或「2」");
  });

  it("remembers developer mode as on only, never as off", () => {
    dirs.push(isolateStateDir());
    const saved = mergeUiPrefs({ developerModeEnabled: true });
    expect(saved.developerModeEnabled).toBe(true);
    const raw = JSON.parse(fs.readFileSync(prefsFile(), "utf8")) as { developerModeEnabled?: boolean };
    expect(raw.developerModeEnabled).toBe(true);
    expect(JSON.stringify(raw)).not.toMatch(/token|pairing|secret/i);
  });

  it("saves setup mode without dropping developer mode", () => {
    dirs.push(isolateStateDir());
    mergeUiPrefs({ developerModeEnabled: true });
    const next = mergeUiPrefs({ setupMode: "manual" });
    expect(next.developerModeEnabled).toBe(true);
    expect(next.setupMode).toBe("manual");
    const auto = mergeUiPrefs({ setupMode: "auto" });
    expect(auto.setupMode).toBe("auto");
    expect(auto.developerModeEnabled).toBe(true);
  });

  it("remembers a shared browser profile independently of setup mode", () => {
    dirs.push(isolateStateDir());
    const shared = mergeUiPrefs({ browserMode: "shared" });
    expect(shared.browserMode).toBe("shared");
    expect(shared.setupMode).toBeNull();
    expect(shared.remembered.browserMode).toBe(true);
    const inApp = mergeUiPrefs({ browserMode: "in-app" });
    expect(inApp.browserMode).toBe("in-app");
  });

  it("rejects an unknown setup mode", () => {
    dirs.push(isolateStateDir());
    expect(() => mergeUiPrefs({ setupMode: "browser" as "auto" })).toThrow(/setup-mode/);
    expect(readUiPrefs().setupMode).toBeNull();
  });

  it("rejects an unknown browser mode", () => {
    dirs.push(isolateStateDir());
    expect(() => mergeUiPrefs({ browserMode: "brave-cookie-copy" as "shared" })).toThrow(/browser-mode/);
    expect(readUiPrefs().browserMode).toBe("in-app");
  });

  it("ignores a hand-edited developerModeEnabled false", () => {
    dirs.push(isolateStateDir());
    fs.mkdirSync(path.dirname(prefsFile()), { recursive: true });
    fs.writeFileSync(
      prefsFile(),
      JSON.stringify({ developerModeEnabled: false, setupMode: "auto", updatedAt: "2026-01-01T00:00:00.000Z" }),
      { mode: 0o600 }
    );
    expect(readUiPrefs().developerModeEnabled).toBe(false);
    expect(readUiPrefs().remembered.developerMode).toBe(false);
    expect(readUiPrefs().setupMode).toBe("auto");
  });
});
