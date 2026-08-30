import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Logger } from "../src/logger/index.js";
import { makeTmpDir, cleanup } from "./helpers.js";

describe("Logger", () => {
  it("neutralizes forged line breaks while retaining one real log record", () => {
    const dir = makeTmpDir("logger");
    const file = path.join(dir, "security.log");
    const logger = new Logger({ file });
    logger.warn("failed input\n2099-01-01 ERROR [fake] forged\rentry");
    const text = fs.readFileSync(file, "utf8");
    expect(text.trimEnd().split("\n")).toHaveLength(1);
    expect(text).toContain("\\n2099-01-01 ERROR");
    expect(text).toContain("\\rentry");
    cleanup(dir);
  });
});
