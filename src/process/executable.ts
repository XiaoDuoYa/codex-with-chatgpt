import fs from "node:fs";
import path from "node:path";

export interface ExecutableSearchOptions {
  /** Absolute executable paths to try after PATH. */
  additionalCandidates?: string[];
  /** Absolute directories to search after PATH. */
  additionalDirectories?: string[];
  forbiddenRoots?: string[];
  override?: string;
  pathValue?: string;
}

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

function normalize(value: string): string {
  const resolved = path.resolve(value);
  return CASE_INSENSITIVE ? resolved.toLowerCase() : resolved;
}

function isInside(candidate: string, root: string): boolean {
  const c = normalize(candidate);
  const r = normalize(root);
  return c === r || c.startsWith(r + path.sep);
}

function executableNames(name: string): string[] {
  if (process.platform !== "win32" || path.extname(name)) return [name];
  const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return extensions.map((extension) => `${name}${extension}`);
}

function trustedFile(candidate: string, forbiddenRoots: string[]): string | null {
  if (!path.isAbsolute(candidate)) return null;
  try {
    const real = fs.realpathSync.native(candidate);
    if (forbiddenRoots.some((root) => isInside(real, root))) return null;
    const stat = fs.statSync(real);
    if (!stat.isFile()) return null;
    fs.accessSync(real, fs.constants.X_OK);
    return real;
  } catch {
    return null;
  }
}

/**
 * Resolve a helper without invoking the operating system's cwd-sensitive
 * executable search. Relative and workspace-local candidates are ignored.
 */
export function findTrustedExecutable(name: string, opts: ExecutableSearchOptions = {}): string | null {
  const forbiddenRoots = (opts.forbiddenRoots ?? []).map((root) => path.resolve(root));
  const names = executableNames(name);
  const candidates: string[] = [];

  if (opts.override) candidates.push(opts.override);
  for (const rawDir of (opts.pathValue ?? process.env.PATH ?? "").split(path.delimiter)) {
    const dir = rawDir.trim().replace(/^"|"$/g, "");
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const executable of names) candidates.push(path.join(dir, executable));
  }
  candidates.push(...(opts.additionalCandidates ?? []));
  for (const dir of opts.additionalDirectories ?? []) {
    if (!path.isAbsolute(dir)) continue;
    for (const executable of names) candidates.push(path.join(dir, executable));
  }

  for (const candidate of candidates) {
    const resolved = trustedFile(candidate, forbiddenRoots);
    if (resolved) return resolved;
  }
  return null;
}
