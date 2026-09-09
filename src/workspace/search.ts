import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Workspace, WorkspaceError } from "./manager.js";

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

export const MAX_SEARCH_QUERY_LENGTH = 1_024;
export const MAX_SEARCH_GLOB_LENGTH = 512;

const RG_CANDIDATES = [
  "rg",
  "/opt/homebrew/bin/rg",
  "/usr/local/bin/rg",
  "/usr/bin/rg",
  "/Applications/Cursor.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg",
  "/Applications/Visual Studio Code.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg",
];

let cachedRg: string | null | undefined;

export function findRipgrep(): string | null {
  if (process.env.C2C_DISABLE_RG === "1") return null;
  if (cachedRg !== undefined) return cachedRg;
  if (process.env.C2C_RG_PATH) {
    cachedRg = process.env.C2C_RG_PATH;
    return cachedRg;
  }
  for (const candidate of RG_CANDIDATES) {
    try {
      const result = spawnSync(candidate, ["--version"], { stdio: "ignore", timeout: 3000 });
      if (result.status === 0) {
        cachedRg = candidate;
        return candidate;
      }
    } catch {
      // try next candidate
    }
  }
  cachedRg = null;
  return null;
}

/** For tests. */
export function resetRipgrepCache(): void {
  cachedRg = undefined;
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
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const hit = line.toLowerCase().includes(needle);
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
  if (opts.query.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new WorkspaceError(
      "SEARCH_QUERY_TOO_LARGE",
      `search query must not exceed ${MAX_SEARCH_QUERY_LENGTH} characters`
    );
  }
  if (opts.glob && opts.glob.length > MAX_SEARCH_GLOB_LENGTH) {
    throw new WorkspaceError(
      "SEARCH_QUERY_TOO_LARGE",
      `search glob must not exceed ${MAX_SEARCH_GLOB_LENGTH} characters`
    );
  }
  const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)));
  const { abs } = ws.resolve(opts.path ?? ".");
  const rg = findRipgrep();
  if (rg) {
    try {
      return await searchWithRipgrep(ws, rg, abs, opts, limit);
    } catch (error) {
      if (opts.regex) {
        throw new WorkspaceError(
          "REGEX_ENGINE_UNAVAILABLE",
          `regular expression search requires a working ripgrep process: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      // fall through to node engine
    }
  }
  if (opts.regex) {
    throw new WorkspaceError(
      "REGEX_ENGINE_UNAVAILABLE",
      "regular expression search requires ripgrep; the Node fallback supports literal search only"
    );
  }
  return searchWithNode(ws, abs, opts, limit);
}
