import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Worker } from "node:worker_threads";
import { Workspace } from "./manager.js";
import { findTrustedExecutable } from "../process/executable.js";

export interface SearchOptions {
  query: string;
  path?: string;
  glob?: string;
  limit?: number;
  regex?: boolean;
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface SearchResult {
  matches: SearchMatch[];
  matchCount: number;
  truncated: boolean;
  engine: "ripgrep" | "node";
}

const RG_CANDIDATES = [
  "/opt/homebrew/bin/rg",
  "/usr/local/bin/rg",
  "/usr/bin/rg",
  "/Applications/Cursor.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg",
  "/Applications/Visual Studio Code.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg",
];

const cachedRg = new Map<string, string | null>();

export function findRipgrep(workspaceRoot?: string): string | null {
  if (process.env.C2C_DISABLE_RG === "1") return null;
  const cacheKey = workspaceRoot ? path.resolve(workspaceRoot) : path.resolve(process.cwd());
  if (cachedRg.has(cacheKey)) return cachedRg.get(cacheKey) ?? null;
  const candidate = findTrustedExecutable("rg", {
    override: process.env.C2C_RG_PATH,
    additionalCandidates: RG_CANDIDATES,
    forbiddenRoots: workspaceRoot ? [workspaceRoot] : [process.cwd()],
  });
  if (candidate) {
    try {
      const result = spawnSync(candidate, ["--version"], { stdio: "ignore", timeout: 3000 });
      if (result.status === 0) {
        cachedRg.set(cacheKey, candidate);
        return candidate;
      }
    } catch {
      // use the bounded Node fallback
    }
  }
  cachedRg.set(cacheKey, null);
  return null;
}

/** For tests. */
export function resetRipgrepCache(): void {
  cachedRg.clear();
}

const REGEX_WORKER_SOURCE = `
  const { parentPort, workerData } = require("node:worker_threads");
  try {
    const expression = new RegExp(workerData.pattern, "i");
    const hits = [];
    for (let index = 0; index < workerData.lines.length; index++) {
      if (expression.test(workerData.lines[index])) hits.push(index);
    }
    parentPort.postMessage({ hits });
  } catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.message : "Invalid regular expression" });
  }
`;

async function boundedRegexMatches(pattern: string, lines: string[]): Promise<number[] | null> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(REGEX_WORKER_SOURCE, {
      eval: true,
      workerData: { pattern, lines },
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      resolve(null);
    }, 500);
    worker.once("message", (message: { hits?: number[]; error?: string }) => {
      clearTimeout(timer);
      void worker.terminate();
      if (message.error) reject(new Error(message.error));
      else resolve(message.hits ?? []);
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function searchWithRipgrep(
  ws: Workspace,
  rgBin: string,
  searchAbs: string,
  opts: SearchOptions,
  limit: number
): Promise<SearchResult> {
  const args = ["--json", "--max-filesize", "2M", "--max-count", "20"];
  if (!opts.regex) args.push("-F");
  args.push("--smart-case");
  if (opts.glob) args.push("-g", opts.glob);
  args.push("--", opts.query, searchAbs);

  return new Promise((resolvePromise, reject) => {
    const child = spawn(rgBin, args, { cwd: ws.root });
    const matches: SearchMatch[] = [];
    let truncated = false;
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (matches.length >= limit) {
        truncated = true;
        child.kill("SIGTERM");
        return;
      }
      try {
        const event = JSON.parse(line) as {
          type: string;
          data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
        };
        if (event.type !== "match" || !event.data?.path?.text) return;
        const rel = path.relative(ws.root, event.data.path.text).split(path.sep).join("/");
        if (rel.startsWith("..") || ws.ignoreRules.isHidden(rel)) return;
        matches.push({
          path: rel,
          line: event.data.line_number ?? 0,
          text: (event.data.lines?.text ?? "").trimEnd().slice(0, 500),
        });
      } catch {
        // ignore malformed json lines
      }
    });
    child.on("error", reject);
    child.on("close", () => {
      resolvePromise({ matches, matchCount: matches.length, truncated, engine: "ripgrep" });
    });
  });
}

async function searchWithNode(
  ws: Workspace,
  searchAbs: string,
  opts: SearchOptions,
  limit: number
): Promise<SearchResult> {
  const needle = opts.query.toLowerCase();
  const globRegex = opts.glob ? globToRegex(opts.glob) : null;
  const matches: SearchMatch[] = [];
  let truncated = false;

  const walk = async (dirAbs: string, dirRel: string): Promise<void> => {
    if (truncated) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      const childRel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      if (ws.ignoreRules.isHidden(childRel) || ws.ignoreRules.isHidden(childRel + "/")) continue;
      const childAbs = path.join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        await walk(childAbs, childRel);
      } else if (entry.isFile()) {
        if (globRegex && !globRegex.test(childRel)) continue;
        let stat: fs.Stats;
        try {
          stat = await fs.promises.stat(childAbs);
        } catch {
          continue;
        }
        if (stat.size > 2 * 1024 * 1024) continue;
        let content: string;
        try {
          content = await fs.promises.readFile(childAbs, "utf8");
        } catch {
          continue;
        }
        if (content.includes("\0")) continue;
        const lines = content.split("\n");
        let regexHits: Set<number> | null = null;
        if (opts.regex) {
          const hitIndexes = await boundedRegexMatches(opts.query, lines);
          if (hitIndexes === null) {
            truncated = true;
            return;
          }
          regexHits = new Set(hitIndexes);
        }
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const hit = regexHits ? regexHits.has(i) : line.toLowerCase().includes(needle);
          if (hit) {
            matches.push({ path: childRel, line: i + 1, text: line.trimEnd().slice(0, 500) });
            if (matches.length >= limit) {
              truncated = true;
              return;
            }
          }
        }
      }
    }
  };

  const startRel = path.relative(ws.root, searchAbs).split(path.sep).join("/");
  await walk(searchAbs, startRel === "" ? "" : startRel);
  return { matches, matchCount: matches.length, truncated, engine: "node" };
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000")
    .replace(/\*\*/g, "\u0001")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, "(?:.*/)?")
    .replace(/\u0001/g, ".*");
  return new RegExp(`(^|/)${escaped}$`, "i");
}

export async function searchWorkspace(ws: Workspace, opts: SearchOptions): Promise<SearchResult> {
  if (!opts.query || opts.query.length < 2) {
    return { matches: [], matchCount: 0, truncated: false, engine: "node" };
  }
  if (opts.query.length > (opts.regex ? 256 : 4096)) {
    throw new Error("Search query is too long");
  }
  if (opts.regex) new RegExp(opts.query, "i");
  const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)));
  const { abs } = ws.resolve(opts.path ?? ".");
  const rg = findRipgrep(ws.root);
  if (rg) {
    try {
      return await searchWithRipgrep(ws, rg, abs, opts, limit);
    } catch {
      // fall through to node engine
    }
  }
  return searchWithNode(ws, abs, opts, limit);
}
