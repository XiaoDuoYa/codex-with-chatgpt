import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { getStateDir } from "./paths.js";

const TABLE = "sandbox_workspace_write";
const KEY = "writable_roots";

export interface SandboxIsolationResult {
  alreadyIsolated: boolean;
  removedRoots: number;
  configPath: string;
}

export interface CodexConfigSnapshot {
  readonly path: string;
  readonly previous:
    | { readonly kind: "missing" }
    | { readonly kind: "file"; readonly bytes: Buffer; readonly mode: number };
}

type TomlQuote = "basic" | "literal" | "multiline-basic" | "multiline-literal";

interface TomlScanState {
  quote: TomlQuote | null;
  squareDepth: number;
  curlyDepth: number;
}

interface TableSpan {
  start: number;
  bodyStart: number;
  end: number;
}

interface ArrayAssignment {
  arrayStart: number;
  arrayEnd: number;
}

interface ArrayToken {
  start: number;
  end: number;
}

interface ArrayItem {
  value: string;
  keep: boolean;
}

interface ArrayLexicalInfo {
  tokens: ArrayToken[];
  commas: number[];
}

export function getCodexHome(): string {
  const fromEnv = process.env.CODEX_HOME?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), ".codex");
}

export function getCodexConfigPath(): string {
  return path.join(getCodexHome(), "config.toml");
}

/** Capture the Codex config before a multi-step setup transaction mutates it. */
export function snapshotCodexConfig(configPath = getCodexConfigPath()): CodexConfigSnapshot {
  const target = path.resolve(configPath);
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return { path: target, previous: { kind: "missing" } };
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Codex config must be a regular file: ${target}`);
  }
  return {
    path: target,
    previous: {
      kind: "file",
      bytes: fs.readFileSync(target),
      mode: stat.mode & 0o777,
    },
  };
}

/** Restore the exact config bytes captured before setup. */
export function restoreCodexConfig(snapshot: CodexConfigSnapshot): void {
  const current = fs.lstatSync(snapshot.path, { throwIfNoEntry: false });
  if (current?.isSymbolicLink()) {
    throw new Error(`Refusing to restore a symlink Codex config: ${snapshot.path}`);
  }
  if (current && !current.isFile()) {
    throw new Error(`Codex config is not a regular file: ${snapshot.path}`);
  }
  if (snapshot.previous.kind === "missing") {
    fs.rmSync(snapshot.path, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(snapshot.path), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(snapshot.path),
    `.${path.basename(snapshot.path)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, snapshot.previous.bytes, {
      flag: "wx",
      mode: snapshot.previous.mode,
    });
    fs.renameSync(temporary, snapshot.path);
    try {
      fs.chmodSync(snapshot.path, snapshot.previous.mode);
    } catch {
      // Best effort on filesystems without chmod semantics.
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** POSIX slashes are valid in TOML and accepted by Codex on Windows. */
export function toTomlPath(p: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\")) return p.replace(/\\/g, "/");
  return path.resolve(p).replace(/\\/g, "/");
}

export function pathsEquivalent(a: string, b: string): boolean {
  const left = normalizeCompare(a);
  const right = normalizeCompare(b);
  if (isWindowsStyle(a) || isWindowsStyle(b)) return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

export function listWritableRoots(content: string): string[] {
  return getWritableRoots(parseConfig(content));
}

/** Remove every obsolete C2C machine-state grant from Codex's global sandbox. */
export function ensureSandboxIsolation(opts?: {
  configPath?: string;
  protectedStateRoot?: string;
}): SandboxIsolationResult {
  const protectedStateRoot = path.resolve(opts?.protectedStateRoot ?? getStateDir());
  const configPath = opts?.configPath ?? getCodexConfigPath();
  const configStat = fs.lstatSync(configPath, { throwIfNoEntry: false });
  if (configStat?.isSymbolicLink() || (configStat && !configStat.isFile())) {
    throw new Error(`Codex config must be a regular file: ${configPath}`);
  }
  if (!configStat) return { alreadyIsolated: true, removedRoots: 0, configPath };

  const previous = fs.readFileSync(configPath, "utf8");
  const roots = listWritableRoots(previous);
  const removedRoots = roots.filter((root) => pathIsWithin(root, protectedStateRoot)).length;
  if (removedRoots === 0) return { alreadyIsolated: true, removedRoots: 0, configPath };

  const next = filterWritableRoots(previous, (root) => !pathIsWithin(root, protectedStateRoot));
  replaceFileAtomically(configPath, next);
  return {
    alreadyIsolated: false,
    removedRoots,
    configPath,
  };
}

/** Filter writable roots while preserving the table and all unrelated config. */
export function filterWritableRoots(content: string, keep: (root: string) => boolean): string {
  const roots = getWritableRoots(parseConfig(content));
  if (roots.length === 0) return content;

  const table = findTable(content, TABLE);
  if (!table) throw new Error(`Unable to locate [${TABLE}] in the Codex config`);
  const assignment = findArrayAssignment(content, table, KEY);
  if (!assignment) throw new Error(`Unable to locate ${KEY} in [${TABLE}]`);

  const items = roots.map((root) => ({ value: toTomlPath(root), keep: keep(root) }));
  const kept = items.filter((item) => item.keep).map((item) => item.value);
  const rawArray = content.slice(assignment.arrayStart, assignment.arrayEnd);
  const rendered = filterArrayPreservingComments(rawArray, items);
  const next = content.slice(0, assignment.arrayStart) + rendered + content.slice(assignment.arrayEnd);

  const reparsedRoots = getWritableRoots(parseConfig(next));
  if (!arraysEqual(reparsedRoots, kept)) {
    throw new Error(`Refusing to write a Codex config whose writable roots could not be verified`);
  }
  return next;
}

function normalizeCompare(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

function isWindowsStyle(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.includes("\\");
}

function pathIsWithin(candidate: string, parent: string): boolean {
  const flavor = isWindowsStyle(candidate) || isWindowsStyle(parent) ? path.win32 : path;
  const normalize = (value: string): string =>
    flavor === path.win32 ? flavor.resolve(value).toLowerCase() : flavor.resolve(value);
  const within = (child: string, root: string): boolean => {
    const relative = flavor.relative(normalize(root), normalize(child));
    return relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${flavor.sep}`) && !flavor.isAbsolute(relative));
  };
  if (within(candidate, parent)) return true;
  try {
    return within(fs.realpathSync.native(candidate), fs.realpathSync.native(parent));
  } catch {
    return false;
  }
}

function escapeTomlString(value: string): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Unable to encode a TOML string");
  return encoded.slice(1, -1);
}

function parseConfig(content: string): Record<string, unknown> {
  try {
    const parsed = parseToml(content);
    if (!isRecord(parsed)) throw new Error("TOML document is not a table");
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Codex config TOML: ${message}`, { cause: error });
  }
}

function getWritableRoots(parsed: Record<string, unknown>): string[] {
  const table = parsed[TABLE];
  if (table === undefined) return [];
  if (!isRecord(table)) throw new Error(`[${TABLE}] must be a TOML table`);
  const value = table[KEY];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((root) => typeof root !== "string")) {
    throw new Error(`[${TABLE}].${KEY} must be an array of strings`);
  }
  return value as string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function findTable(content: string, name: string): TableSpan | null {
  const headers = findTableHeaders(content);
  const index = headers.findIndex((header) => header.name === name);
  if (index < 0) return null;
  const header = headers[index];
  return {
    start: header.start,
    bodyStart: header.bodyStart,
    end: headers[index + 1]?.start ?? content.length,
  };
}

function findTableHeaders(content: string): Array<{ name: string; start: number; bodyStart: number }> {
  const headers: Array<{ name: string; start: number; bodyStart: number }> = [];
  const state = newTomlScanState();
  let lineStart = 0;
  while (lineStart < content.length) {
    const lineEnd = content.indexOf("\n", lineStart);
    const end = lineEnd < 0 ? content.length : lineEnd;
    if (state.quote === null && state.squareDepth === 0 && state.curlyDepth === 0) {
      const header = parseTableHeader(content, lineStart, end);
      if (header) headers.push({ name: header.name, start: lineStart, bodyStart: lineEnd < 0 ? end : lineEnd + 1 });
    }
    scanTomlRange(content, lineStart, end, state);
    lineStart = lineEnd < 0 ? content.length : lineEnd + 1;
  }
  return headers;
}

function parseTableHeader(content: string, lineStart: number, lineEnd: number): { name: string } | null {
  let cursor = skipHorizontalWhitespace(content, lineStart, lineEnd);
  if (cursor >= lineEnd || content[cursor] !== "[" || content[cursor + 1] === "[") return null;
  const opening = cursor;
  cursor += 1;
  while (cursor < lineEnd) {
    const char = content[cursor];
    if (char === "\"" || char === "'") {
      cursor = scanStringEnd(content, cursor, lineEnd);
      continue;
    }
    if (char === "]") {
      const remainder = content.slice(cursor + 1, lineEnd);
      if (/^[ \t\r]*(?:#.*)?$/.test(remainder)) {
        const name = content.slice(opening + 1, cursor).trim();
        return name ? { name } : null;
      }
      return null;
    }
    cursor += 1;
  }
  return null;
}

function findArrayAssignment(content: string, table: TableSpan, key: string): ArrayAssignment | null {
  const state = newTomlScanState();
  let lineStart = table.bodyStart;
  while (lineStart < table.end) {
    const lineEnd = content.indexOf("\n", lineStart);
    const end = Math.min(lineEnd < 0 ? content.length : lineEnd, table.end);
    if (state.quote === null && state.squareDepth === 0 && state.curlyDepth === 0) {
      const assignment = parseAssignment(content, lineStart, end, key);
      if (assignment) {
        const arrayStart = findValueStart(content, assignment.valueStart, table.end);
        if (content[arrayStart] !== "[") {
          throw new Error(`[${TABLE}].${KEY} must be a TOML array`);
        }
        const arrayEnd = scanBracketedValue(content, arrayStart, table.end);
        return { arrayStart, arrayEnd };
      }
    }
    scanTomlRange(content, lineStart, end, state);
    if (end >= table.end || lineEnd < 0) break;
    lineStart = lineEnd + 1;
  }
  return null;
}

function parseAssignment(
  content: string,
  lineStart: number,
  lineEnd: number,
  key: string,
): { valueStart: number } | null {
  let cursor = skipHorizontalWhitespace(content, lineStart, lineEnd);
  if (cursor >= lineEnd || content[cursor] === "#") return null;
  const parsedKey = readKey(content, cursor, lineEnd);
  if (!parsedKey || parsedKey.name !== key) return null;
  cursor = skipHorizontalWhitespace(content, parsedKey.end, lineEnd);
  return content[cursor] === "=" ? { valueStart: cursor + 1 } : null;
}

function readKey(content: string, start: number, limit: number): { name: string; end: number } | null {
  const quote = content[start];
  if (quote === "\"" || quote === "'") {
    const triple = content.startsWith(quote.repeat(3), start);
    if (triple) return null;
    const end = scanStringEnd(content, start, limit);
    const raw = content.slice(start, end);
    if (quote === "'") return { name: raw.slice(1, -1), end };
    try {
      return { name: JSON.parse(raw) as string, end };
    } catch {
      return null;
    }
  }
  if (!/[A-Za-z0-9_-]/.test(quote ?? "")) return null;
  let end = start + 1;
  while (end < limit && /[A-Za-z0-9_-]/.test(content[end] ?? "")) end += 1;
  return { name: content.slice(start, end), end };
}

function findValueStart(content: string, start: number, limit: number): number {
  let cursor = start;
  while (cursor < limit) {
    while (cursor < limit && /[ \t\r\n]/.test(content[cursor] ?? "")) cursor += 1;
    if (content[cursor] !== "#") return cursor;
    const newline = content.indexOf("\n", cursor);
    if (newline < 0 || newline >= limit) return limit;
    cursor = newline + 1;
  }
  return cursor;
}

function scanBracketedValue(content: string, start: number, limit: number): number {
  let depth = 0;
  let cursor = start;
  while (cursor < limit) {
    const char = content[cursor];
    if (char === "\"" || char === "'") {
      cursor = scanStringEnd(content, cursor, limit);
      continue;
    }
    if (char === "#") {
      const newline = content.indexOf("\n", cursor);
      cursor = newline < 0 || newline >= limit ? limit : newline + 1;
      continue;
    }
    if (char === "[") depth += 1;
    if (char === "]") {
      depth -= 1;
      if (depth === 0) return cursor + 1;
      if (depth < 0) throw new Error(`Malformed ${KEY} TOML array`);
    }
    cursor += 1;
  }
  throw new Error(`Malformed ${KEY} TOML array`);
}

function scanStringEnd(content: string, start: number, limit: number): number {
  const quote = content[start];
  const triple = content.startsWith((quote ?? "").repeat(3), start);
  const multiline = triple;
  const close = triple ? (quote ?? "").repeat(3) : quote;
  let cursor = start + (triple ? 3 : 1);
  while (cursor < limit) {
    if (content.startsWith(close ?? "", cursor) && (quote === "'" || !isEscaped(content, cursor))) {
      return cursor + (triple ? 3 : 1);
    }
    if (quote === "\"" && content[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (!multiline && content[cursor] === "\n") break;
    cursor += 1;
  }
  throw new Error("Malformed TOML quoted string");
}

function isEscaped(content: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && content[cursor] === "\\"; cursor -= 1) slashCount += 1;
  return slashCount % 2 === 1;
}

function filterArrayPreservingComments(rawArray: string, items: readonly ArrayItem[]): string {
  const lexical = scanArrayLexical(rawArray);
  if (lexical.tokens.length !== items.length) {
    throw new Error(`Unable to tokenize ${KEY} TOML array`);
  }

  const keptIndexes = items.flatMap((item, index) => item.keep ? [index] : []);
  const retainedCommas = new Set<number>();
  for (let index = 1; index < keptIndexes.length; index += 1) {
    const previous = lexical.tokens[keptIndexes[index - 1]];
    const current = lexical.tokens[keptIndexes[index]];
    const comma = lexical.commas.find((position) => position >= previous.end && position < current.start);
    if (comma === undefined) throw new Error(`Unable to tokenize ${KEY} TOML array separators`);
    retainedCommas.add(comma);
  }
  const lastKept = keptIndexes.at(-1);
  if (lastKept !== undefined) {
    const trailing = lexical.commas.find((position) => position > lexical.tokens[lastKept].end);
    if (trailing !== undefined) retainedCommas.add(trailing);
  }

  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  lexical.tokens.forEach((token, index) => {
    edits.push({
      start: token.start,
      end: token.end,
      replacement: items[index].keep ? `"${escapeTomlString(items[index].value)}"` : "",
    });
  });
  for (const comma of lexical.commas) {
    if (!retainedCommas.has(comma)) edits.push({ start: comma, end: comma + 1, replacement: "" });
  }
  edits.sort((left, right) => left.start - right.start);
  let result = "";
  let cursor = 0;
  for (const edit of edits) {
    result += rawArray.slice(cursor, edit.start) + edit.replacement;
    cursor = edit.end;
  }
  return result + rawArray.slice(cursor);
}

function scanArrayLexical(rawArray: string): ArrayLexicalInfo {
  const tokens: ArrayToken[] = [];
  const commas: number[] = [];
  let depth = 0;
  let cursor = 0;
  while (cursor < rawArray.length) {
    const char = rawArray[cursor];
    if (char === "\"" || char === "'") {
      const end = scanStringEnd(rawArray, cursor, rawArray.length);
      if (depth === 1) tokens.push({ start: cursor, end });
      cursor = end;
      continue;
    }
    if (char === "#") {
      const newline = rawArray.indexOf("\n", cursor);
      cursor = newline < 0 ? rawArray.length : newline + 1;
      continue;
    }
    if (char === "[") depth += 1;
    else if (char === "]") depth -= 1;
    else if (char === "," && depth === 1) commas.push(cursor);
    cursor += 1;
  }
  if (depth !== 0) throw new Error(`Malformed ${KEY} TOML array`);
  return { tokens, commas };
}

function skipHorizontalWhitespace(content: string, start: number, limit: number): number {
  let cursor = start;
  while (cursor < limit && /[ \t]/.test(content[cursor] ?? "")) cursor += 1;
  return cursor;
}

function newTomlScanState(): TomlScanState {
  return { quote: null, squareDepth: 0, curlyDepth: 0 };
}

function scanTomlRange(content: string, start: number, end: number, state: TomlScanState): void {
  let cursor = start;
  while (cursor < end) {
    if (state.quote) {
      const result = advanceQuotedString(content, cursor, end, state.quote);
      if (result === null) return;
      cursor = result.next;
      if (result.closed) state.quote = null;
      continue;
    }
    const char = content[cursor];
    if (char === "#") return;
    if (char === "\"" || char === "'") {
      const triple = content.startsWith(char.repeat(3), cursor);
      state.quote = triple
        ? char === "\"" ? "multiline-basic" : "multiline-literal"
        : char === "\"" ? "basic" : "literal";
      cursor += triple ? 3 : 1;
      continue;
    }
    if (char === "[") state.squareDepth += 1;
    else if (char === "]") state.squareDepth = Math.max(0, state.squareDepth - 1);
    else if (char === "{") state.curlyDepth += 1;
    else if (char === "}") state.curlyDepth = Math.max(0, state.curlyDepth - 1);
    cursor += 1;
  }
}

function advanceQuotedString(
  content: string,
  start: number,
  limit: number,
  quote: TomlQuote,
): { next: number; closed: boolean } | null {
  const isMultiline = quote === "multiline-basic" || quote === "multiline-literal";
  const delimiter = isMultiline ? (quote.endsWith("basic") ? '\"\"\"' : "'''" ) : quote === "basic" ? '\"' : "'";
  if (content.startsWith(delimiter, start) && (quote.endsWith("literal") || !isEscaped(content, start))) {
    return { next: start + delimiter.length, closed: true };
  }
  if (!isMultiline && content[start] === "\n") return null;
  if (quote.endsWith("basic") && content[start] === "\\") {
    return { next: Math.min(start + 2, limit), closed: false };
  }
  return { next: start + 1, closed: false };
}

function replaceFileAtomically(target: string, content: string): void {
  const directory = path.dirname(target);
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, content, { encoding: "utf8" });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try {
      fs.chmodSync(temporary, 0o600);
    } catch {
      // Best effort on filesystems without chmod semantics.
    }
    fs.renameSync(temporary, target);
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      // Best effort on filesystems without chmod semantics.
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}
