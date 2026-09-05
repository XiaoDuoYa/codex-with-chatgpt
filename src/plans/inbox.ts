import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getStateDir } from "../config/paths.js";
import { DuplicateJsonMemberError, parseJsonNoDuplicates } from "./json.js";


const MAX_PLAN_BYTES = 256 * 1024;
const MAX_FILES = 500;
const MAX_FILE_BYTES = 1_000_000;
const MAX_TOTAL_BYTES = 10_000_000;
const DEFAULT_TTL_MS = 10 * 60_000;
const MAX_ACTIVE_AUTHORIZATIONS = 100;
const SECTION_NAMES = ["FILES_USED", "ASSUMPTIONS", "PLAN", "OPEN_QUESTIONS"] as const;
const SECTION_RE = /^(FILES_USED|ASSUMPTIONS|PLAN|OPEN_QUESTIONS):\s*$/gm;
const HASH_RE = /^[0-9a-f]{64}$/;
const ALLOWED_SUFFIXES = new Set([
  ".css", ".csv", ".go", ".graphql", ".html", ".java", ".js", ".json", ".jsx", ".md", ".mjs",
  ".py", ".rs", ".sh", ".sql", ".toml", ".ts", ".tsx", ".txt", ".yaml", ".yml",
]);
const ALLOWED_EXTENSIONLESS = new Set(["Dockerfile", "Makefile", "README", "LICENSE"]);
const SENSITIVE_EXACT = new Set([
  ".env", ".git", ".ssh", ".aws", ".npmrc", ".pypirc", "id_rsa", "id_ed25519", "credentials",
  "credentials.json", "secrets", "secrets.json", "auth.json",
]);
const SENSITIVE_PART = /(^|[._-])(secret|credential|password|passwd|private[-_]?key|access[-_]?token|refresh[-_]?token)([._-]|$)/i;
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/,
  /\b(?:ghp|github_pat|xox[baprs])[_-][A-Za-z0-9_-]{16,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\bauthorization\s*:\s*bearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}/i,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:/]+:[^\s@/]{4,}@/i,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|private[_-]?key)\b\s*[:=]\s*["']?[^\s"']{8,}/i,
];

export class PlanInboxError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "PlanInboxError";
  }
}

interface ManifestFile {
  path: string;
  bytes: number;
  sha256: string;
}

interface StagedManifest {
  schema: 2;
  project: string;
  classification: "public" | "synthetic" | "sanitized";
  files: ManifestFile[];
  limits: { max_file_bytes: number; max_total_bytes: number };
  approval_digest: string;
}

interface AuthorizationRecord {
  project: string;
  digest: string;
  expiresAt: number;
}

export interface PlanReceipt {
  path: string;
  sha256: string;
  bytes: number;
  project: string;
  stagedDigest: string;
  createdAt: string;
}

function sha256Hex(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function jsonString(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${jsonString(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  if (typeof value === "string") return jsonString(value);
  return JSON.stringify(value);
}

function isInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function assertPrivateDirectory(directory: string, label: string): string {
  let info: fs.Stats;
  try {
    info = fs.lstatSync(directory);
  } catch {
    throw new PlanInboxError("UNSAFE_INBOX", `${label} does not exist.`);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new PlanInboxError("UNSAFE_INBOX", `${label} must be a real directory, not a symlink.`);
  }
  if (process.platform !== "win32") {
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new PlanInboxError("UNSAFE_INBOX", `${label} must be owned by the current user.`);
    }
    if ((info.mode & 0o077) !== 0) {
      throw new PlanInboxError("UNSAFE_INBOX", `${label} must not be accessible by group or other users.`);
    }
  }
  return fs.realpathSync.native(directory);
}

function assertNoSymlinkAncestors(directory: string): void {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    let info: fs.Stats;
    try {
      info = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new PlanInboxError("UNSAFE_INBOX", "The C2C state-directory ancestry could not be validated.");
    }
    if (info.isSymbolicLink()) {
      throw new PlanInboxError("UNSAFE_INBOX", "The C2C state-directory ancestry must not contain symlinks.");
    }
    if (!info.isDirectory()) {
      throw new PlanInboxError("UNSAFE_INBOX", "The C2C state-directory ancestry must contain only directories.");
    }
  }
}

function secureRoot(directory: string): string {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new PlanInboxError("UNSAFE_INBOX", "The C2C state directory must be a real directory, not a symlink.");
  }
  if (process.platform !== "win32") {
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new PlanInboxError("UNSAFE_INBOX", "The C2C state directory must be owned by the current user.");
    }
    fs.chmodSync(directory, 0o700);
  }
  return assertPrivateDirectory(directory, "The C2C state directory");
}

function secureChild(parent: string, name: string): string {
  const canonicalParent = assertPrivateDirectory(parent, "The plan inbox parent");
  if (canonicalParent !== parent) {
    throw new PlanInboxError("UNSAFE_INBOX", "The plan inbox parent changed or became a symlink.");
  }
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new PlanInboxError("UNSAFE_INBOX", "The plan inbox component is invalid.");
  }
  const directory = path.join(parent, name);
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const canonical = assertPrivateDirectory(directory, "The plan inbox directory");
  if (!isInside(canonical, parent) || canonical === parent) {
    throw new PlanInboxError("UNSAFE_INBOX", "The plan inbox escaped its secure parent.");
  }
  return canonical;
}

function readRegularFile(file: string, maxBytes: number, code: string): Buffer {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  } catch {
    throw new PlanInboxError(code, "A staged file could not be opened safely.");
  }
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size > maxBytes) {
      throw new PlanInboxError(code, "A staged file is not a bounded regular file.");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const count = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) break;
      chunks.push(chunk.subarray(0, count));
      total += count;
    }
    const after = fs.fstatSync(descriptor);
    if (
      total > maxBytes ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      total !== after.size
    ) {
      throw new PlanInboxError(code, "A staged file changed or exceeded its size limit while being read.");
    }
    return Buffer.concat(chunks, total);
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertPrivateStagedDirectory(directory: string): void {
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new PlanInboxError("STAGED_CONTENT_CHANGED", "Every staged directory must be a real directory.");
  }
  if (process.platform !== "win32") {
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new PlanInboxError("STAGED_CONTENT_CHANGED", "Every staged directory must be owned by the current user.");
    }
    if ((info.mode & 0o077) !== 0) {
      throw new PlanInboxError("STAGED_CONTENT_CHANGED", "Every staged directory must be owner-only.");
    }
  }
}

function validProject(project: string): boolean {
  return project.length > 0 && project !== "." && project !== ".." && !project.startsWith(".") &&
    path.basename(project) === project && !project.includes("/") && !project.includes("\\") && !project.includes("\0");
}

function validRelativeFile(relative: string): boolean {
  if (!relative || relative.includes("\0") || relative.includes("\\") || path.posix.isAbsolute(relative)) return false;
  const parts = relative.split("/");
  if (!parts.every((part) => part !== "" && part !== "." && part !== "..")) return false;
  if (parts.length === 1 && parts[0].toLowerCase() === "context-manifest.json") return false;
  for (const component of parts) {
    const lowered = component.toLowerCase();
    if (SENSITIVE_EXACT.has(lowered) || lowered.startsWith(".env.") || SENSITIVE_PART.test(component)) return false;
  }
  const name = parts[parts.length - 1];
  return ALLOWED_SUFFIXES.has(path.posix.extname(name).toLowerCase()) || ALLOWED_EXTENSIONLESS.has(name);
}

function validateStagedText(data: Buffer): void {
  const text = data.toString("utf8");
  if (data.includes(0) || Buffer.from(text, "utf8").compare(data) !== 0) {
    throw new PlanInboxError("STAGED_CONTENT_CHANGED", "Every staged file must be UTF-8 text without NUL bytes.");
  }
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new PlanInboxError("STAGED_CONTENT_CHANGED", "A staged file contains secret-like content.");
  }
}

function readManifest(file: string): StagedManifest {
  let parsed: unknown;
  try {
    const data = readRegularFile(file, MAX_TOTAL_BYTES, "INVALID_MANIFEST");
    const text = data.toString("utf8");
    if (Buffer.from(text, "utf8").compare(data) !== 0) {
      throw new SyntaxError("Invalid UTF-8");
    }
    parsed = parseJsonNoDuplicates(text);
  } catch (error) {
    if (error instanceof DuplicateJsonMemberError) {
      throw new PlanInboxError("INVALID_MANIFEST", error.message);
    }
    if (error instanceof PlanInboxError) throw error;
    throw new PlanInboxError("INVALID_MANIFEST", "The staged manifest is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PlanInboxError("INVALID_MANIFEST", "The staged manifest is invalid.");
  }
  const manifest = parsed as Record<string, unknown>;
  const expectedKeys = ["approval_digest", "classification", "files", "limits", "project", "schema"];
  if (Object.keys(manifest).sort().join("\0") !== expectedKeys.join("\0")) {
    throw new PlanInboxError("INVALID_MANIFEST", "The staged manifest fields are invalid.");
  }
  if (
    manifest.schema !== 2 ||
    typeof manifest.project !== "string" ||
    !validProject(manifest.project) ||
    !["public", "synthetic", "sanitized"].includes(String(manifest.classification)) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0 ||
    manifest.files.length > MAX_FILES ||
    typeof manifest.approval_digest !== "string" ||
    !HASH_RE.test(manifest.approval_digest)
  ) {
    throw new PlanInboxError("INVALID_MANIFEST", "The staged manifest values are invalid.");
  }
  const limits = manifest.limits as Record<string, unknown> | null;
  if (
    !limits ||
    Object.keys(limits).sort().join("\0") !== "max_file_bytes\0max_total_bytes" ||
    limits.max_file_bytes !== MAX_FILE_BYTES ||
    limits.max_total_bytes !== MAX_TOTAL_BYTES
  ) {
    throw new PlanInboxError("INVALID_MANIFEST", "The staged manifest limits are invalid.");
  }
  let total = 0;
  const seen = new Set<string>();
  const files: ManifestFile[] = manifest.files.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new PlanInboxError("INVALID_MANIFEST", "The staged manifest file list is invalid.");
    }
    const item = value as Record<string, unknown>;
    if (
      Object.keys(item).sort().join("\0") !== "bytes\0path\0sha256" ||
      typeof item.path !== "string" ||
      !validRelativeFile(item.path) ||
      seen.has(item.path) ||
      !Number.isSafeInteger(item.bytes) ||
      Number(item.bytes) < 0 ||
      Number(item.bytes) > MAX_FILE_BYTES ||
      typeof item.sha256 !== "string" ||
      !HASH_RE.test(item.sha256)
    ) {
      throw new PlanInboxError("INVALID_MANIFEST", "The staged manifest file entry is invalid.");
    }
    seen.add(item.path);
    total += Number(item.bytes);
    if (total > MAX_TOTAL_BYTES) {
      throw new PlanInboxError("INVALID_MANIFEST", "The staged manifest exceeds the total size limit.");
    }
    return { path: item.path, bytes: Number(item.bytes), sha256: item.sha256 };
  });
  return {
    schema: 2,
    project: manifest.project,
    classification: manifest.classification as StagedManifest["classification"],
    files,
    limits: { max_file_bytes: MAX_FILE_BYTES, max_total_bytes: MAX_TOTAL_BYTES },
    approval_digest: manifest.approval_digest,
  };
}

function listRegularFiles(root: string, prefix = ""): string[] {
  assertPrivateStagedDirectory(root);
  const result: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(root, entry.name);
    const info = fs.lstatSync(absolute);
    if (info.isSymbolicLink()) throw new PlanInboxError("STAGED_CONTENT_CHANGED", "A staged symlink is not allowed.");
    if (info.isDirectory()) result.push(...listRegularFiles(absolute, relative));
    else if (info.isFile()) result.push(relative);
    else throw new PlanInboxError("STAGED_CONTENT_CHANGED", "The staged project contains an unsupported entry.");
  }
  return result;
}

function sections(content: string): Map<string, string> {
  const matches = [...content.matchAll(SECTION_RE)];
  if (
    matches[0]?.index !== 0 ||
    matches.map((match) => match[1]).join("\0") !== SECTION_NAMES.join("\0")
  ) {
    throw new PlanInboxError("INVALID_PLAN", "The plan sections are missing, duplicated, or out of order.");
  }
  const result = new Map<string, string>();
  matches.forEach((match, index) => {
    const end = matches[index + 1]?.index ?? content.length;
    const body = content.slice((match.index ?? 0) + match[0].length, end).trim();
    if (!body) throw new PlanInboxError("INVALID_PLAN", `The ${match[1]} section is empty.`);
    result.set(match[1], body);
  });
  return result;
}

function validatePlan(content: string, approvedPaths: Set<string>): Buffer {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length === 0 || bytes.length > MAX_PLAN_BYTES || bytes.toString("utf8") !== content || content.includes("\0")) {
    throw new PlanInboxError("INVALID_PLAN", "The plan must be bounded UTF-8 text.");
  }
  const used = sections(content).get("FILES_USED")!;
  const seen = new Set<string>();
  for (const line of used.split(/\r?\n/)) {
    const match = /^-\s+`?([^`]+?)`?\s*$/.exec(line.trim());
    if (!match || !validRelativeFile(match[1]) || !approvedPaths.has(match[1]) || seen.has(match[1])) {
      throw new PlanInboxError("INVALID_PLAN", "FILES_USED must contain unique approved relative paths.");
    }
    seen.add(match[1]);
  }
  if (seen.size === 0) throw new PlanInboxError("INVALID_PLAN", "FILES_USED must not be empty.");
  return bytes;
}

export class PlanInbox {
  private readonly workspaceRoot: string;
  private readonly inboxRoot: string;
  private readonly workspaceId: string;
  private readonly supported: boolean;
  private readonly authorizations = new Map<string, AuthorizationRecord>();

  constructor(opts: { workspaceRoot: string; workspaceId: string; platform?: NodeJS.Platform }) {
    this.workspaceRoot = fs.realpathSync.native(opts.workspaceRoot);
    this.workspaceId = opts.workspaceId;
    this.supported = (opts.platform ?? process.platform) !== "win32";
    if (!this.supported) {
      this.inboxRoot = "";
      return;
    }
    const requestedStateRoot = path.resolve(getStateDir());
    if (isInside(requestedStateRoot, this.workspaceRoot) || isInside(this.workspaceRoot, requestedStateRoot)) {
      throw new PlanInboxError("UNSAFE_INBOX", "The plan inbox must be separate from the connected workspace.");
    }
    assertNoSymlinkAncestors(requestedStateRoot);
    const stateRoot = secureRoot(requestedStateRoot);
    const planRoot = secureChild(stateRoot, "plan-inbox");
    this.inboxRoot = secureChild(planRoot, opts.workspaceId);
    if (isInside(this.inboxRoot, this.workspaceRoot) || isInside(this.workspaceRoot, this.inboxRoot)) {
      throw new PlanInboxError("UNSAFE_INBOX", "The plan inbox must be separate from the connected workspace.");
    }
  }

  authorize(input: { project: string; digest: string; ttlMs?: number }): { token: string; expiresAt: number } {
    this.requireSupportedPlatform();
    this.verifyStagedProject(input.project, input.digest);
    const now = Date.now();
    for (const [key, authorization] of this.authorizations) {
      if (now >= authorization.expiresAt) this.authorizations.delete(key);
    }
    if (this.authorizations.size >= MAX_ACTIVE_AUTHORIZATIONS) {
      throw new PlanInboxError("AUTHORIZATION_LIMIT", "Too many active plan authorizations.");
    }
    const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > DEFAULT_TTL_MS) {
      throw new PlanInboxError("INVALID_TTL", "Plan authorization TTL must be between 1 ms and 10 minutes.");
    }
    const token = `c2c_plan_${randomBytes(32).toString("base64url")}`;
    const expiresAt = now + ttlMs;
    this.authorizations.set(sha256Hex(token), { project: input.project, digest: input.digest, expiresAt });
    return { token, expiresAt };
  }

  submit(input: { project: string; digest: string; authorization: string; content: string }): PlanReceipt {
    this.requireSupportedPlatform();
    const key = sha256Hex(input.authorization);
    const authorization = this.authorizations.get(key);
    this.authorizations.delete(key);
    if (
      !authorization ||
      Date.now() >= authorization.expiresAt ||
      !safeEqual(authorization.project, input.project) ||
      !safeEqual(authorization.digest, input.digest)
    ) {
      throw new PlanInboxError("INVALID_AUTHORIZATION", "The plan authorization is invalid, expired, or already used.");
    }
    const manifest = this.verifyStagedProject(input.project, input.digest);
    const bytes = validatePlan(input.content, new Set(manifest.files.map((item) => item.path)));
    const projectInbox = secureChild(this.inboxRoot, input.project);
    const destination = secureChild(projectInbox, input.digest);
    const createdAt = new Date().toISOString();
    const filename = `${Date.now()}-${randomBytes(8).toString("hex")}.md`;
    const file = path.join(destination, filename);
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
    try {
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.chmodSync(file, 0o600);
    return {
      path: `plan-inbox:/${this.workspaceId}/${input.project}/${input.digest}/${filename}`,
      sha256: sha256Hex(bytes),
      bytes: bytes.length,
      project: input.project,
      stagedDigest: input.digest,
      createdAt,
    };
  }

  private verifyStagedProject(project: string, digest: string): StagedManifest {
    if (!validProject(project) || !HASH_RE.test(digest)) {
      throw new PlanInboxError("INVALID_BINDING", "The project or staged digest is invalid.");
    }
    const projectRoot = path.join(this.workspaceRoot, project);
    let canonicalProject: string;
    try {
      canonicalProject = fs.realpathSync.native(projectRoot);
    } catch {
      throw new PlanInboxError("INVALID_BINDING", "The staged project does not exist.");
    }
    if (!isInside(canonicalProject, this.workspaceRoot) || canonicalProject === this.workspaceRoot) {
      throw new PlanInboxError("INVALID_BINDING", "The staged project is outside the connected workspace.");
    }
    assertPrivateStagedDirectory(this.workspaceRoot);
    assertPrivateStagedDirectory(canonicalProject);
    const manifestPath = path.join(canonicalProject, "CONTEXT-MANIFEST.json");
    const manifest = readManifest(manifestPath);
    if (manifest.project !== project || !safeEqual(manifest.approval_digest, digest)) {
      throw new PlanInboxError("INVALID_BINDING", "The staged manifest does not match the requested project and digest.");
    }
    const release = {
      schema: manifest.schema,
      project: manifest.project,
      classification: manifest.classification,
      files: manifest.files,
      limits: manifest.limits,
    };
    const recomputed = sha256Hex(canonicalJson(release) + "\n");
    if (!safeEqual(recomputed, digest)) {
      throw new PlanInboxError("INVALID_MANIFEST", "The approval digest does not bind the staged manifest.");
    }
    const expected = new Set(manifest.files.map((item) => item.path));
    const actual = listRegularFiles(canonicalProject).filter((relative) => relative !== "CONTEXT-MANIFEST.json");
    if (actual.length !== expected.size || actual.some((relative) => !expected.has(relative))) {
      throw new PlanInboxError("STAGED_CONTENT_CHANGED", "The staged file set does not match the manifest.");
    }
    for (const item of manifest.files) {
      const absolute = path.join(canonicalProject, ...item.path.split("/"));
      const data = readRegularFile(absolute, MAX_FILE_BYTES, "STAGED_CONTENT_CHANGED");
      validateStagedText(data);
      if (data.length !== item.bytes || !safeEqual(sha256Hex(data), item.sha256)) {
        throw new PlanInboxError("STAGED_CONTENT_CHANGED", "A staged file no longer matches the manifest.");
      }
    }
    return manifest;
  }

  private requireSupportedPlatform(): void {
    if (!this.supported) {
      throw new PlanInboxError(
        "UNSUPPORTED_PLATFORM",
        "Plan submission is disabled on Windows until owner-only ACL enforcement is available."
      );
    }
  }
}
