import { createHash, type Hash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { writeSecureJson } from "../config/paths.js";
import { isolatedGitEnvironment } from "../config/git-environment.js";

export const SOURCE_METADATA_FILENAME = "source-metadata.json";

export interface SourceMetadata {
  readonly schemaVersion: 1;
  readonly revision: string | null;
  readonly repository: string | null;
  readonly ref: string | null;
  /** Remote tip observed while this runtime was installed. */
  readonly baselineRemoteRevision: string | null;
  /** Digest of the package inputs copied into the installed runtime. */
  readonly contentDigest: string;
}

function validRevision(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40,64}$/i.test(value);
}

function validRef(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

/** Strip credentials and query fragments before a repository URL is persisted. */
export function sanitizeRepository(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.length > 2_048 || /[\u0000-\u001f\u007f]/.test(raw)) return null;

  const scp = !raw.includes("://")
    ? /^(?:(?<user>[^@/:\s]+)@)?(?<host>[^/:\s]+):(?<path>.+)$/.exec(raw)
    : null;
  if (scp?.groups) {
    const user = scp.groups.user ? `${scp.groups.user}@` : "";
    return `ssh://${user}${scp.groups.host}/${scp.groups.path}`;
  }

  try {
    const parsed = new URL(raw);
    if (!["file:", "git:", "http:", "https:", "ssh:"].includes(parsed.protocol)) return null;
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function metadataPath(root: string): string {
  return path.join(path.resolve(root), SOURCE_METADATA_FILENAME);
}

function parseMetadata(value: unknown): SourceMetadata | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error("runtime source metadata is malformed");
  }
  const raw = value as Record<string, unknown>;
  // Metadata written before contentDigest cannot prove that the deployed
  // package matches its source. Treat it as stale so the installer rebuilds
  // it instead of failing the whole machine setup.
  if (!Object.hasOwn(raw, "contentDigest")) return null;
  if (
    Object.keys(value).sort().join(",") !==
    "baselineRemoteRevision,contentDigest,ref,repository,revision,schemaVersion"
  ) {
    throw new Error("runtime source metadata is malformed");
  }
  const nullableRevision = (field: string): string | null => {
    const candidate = raw[field];
    if (candidate === null) return null;
    if (!validRevision(candidate)) throw new Error(`runtime source metadata ${field} is invalid`);
    return candidate.toLowerCase();
  };
  const repository = raw.repository === null ? null : sanitizeRepository(raw.repository);
  if (raw.repository !== null && repository === null) {
    throw new Error("runtime source metadata repository is invalid");
  }
  const ref = raw.ref === null ? null : raw.ref;
  if (ref !== null && !validRef(ref)) throw new Error("runtime source metadata ref is invalid");
  if (raw.schemaVersion !== 1) throw new Error("runtime source metadata version is invalid");
  if (typeof raw.contentDigest !== "string" || !/^[a-f0-9]{64}$/i.test(raw.contentDigest)) {
    throw new Error("runtime source metadata contentDigest is invalid");
  }
  return {
    schemaVersion: 1,
    revision: nullableRevision("revision"),
    repository,
    ref,
    baselineRemoteRevision: nullableRevision("baselineRemoteRevision"),
    contentDigest: raw.contentDigest.toLowerCase(),
  };
}

export function readSourceMetadata(root: string): SourceMetadata | null {
  const file = metadataPath(root);
  try {
    return parseMetadata(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new Error("runtime source metadata is malformed");
    throw error;
  }
}

export function writeSourceMetadata(root: string, metadata: SourceMetadata): void {
  const parsed = parseMetadata(metadata);
  if (!parsed) throw new Error("runtime source metadata contentDigest is required");
  writeSecureJson(metadataPath(root), parsed);
}

function hashText(hash: Hash, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  hash.update(`${bytes.byteLength}:`);
  hash.update(bytes);
}

function relativeDigestPath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

function hashContentEntry(hash: Hash, root: string, file: string): void {
  const stat = fs.lstatSync(file);
  const relative = relativeDigestPath(root, file);
  hashText(hash, "entry");
  hashText(hash, relative);
  if (stat.isDirectory()) {
    hashText(hash, "directory");
    hashText(hash, String(stat.mode & 0o777));
    const entries = fs.readdirSync(file).sort();
    for (const entry of entries) hashContentEntry(hash, root, path.join(file, entry));
    return;
  }
  if (stat.isFile()) {
    hashText(hash, "file");
    hashText(hash, String(stat.mode & 0o777));
    const content = fs.readFileSync(file);
    hashText(hash, String(content.byteLength));
    hash.update(content);
    return;
  }
  if (stat.isSymbolicLink()) {
    // Hash the link itself and its target without following it. The installer
    // rejects package-input symlinks, so this cannot escape the source tree.
    hashText(hash, "symlink");
    hashText(hash, fs.readlinkSync(file));
    return;
  }
  throw new Error(`runtime content input is not a regular file, directory, or symlink: ${file}`);
}

/** Compute a stable digest for the package inputs copied into a runtime stage. */
export function computeContentDigest(root: string, inputs: readonly string[]): string {
  const sourceRoot = path.resolve(root);
  const hash = createHash("sha256");
  hashText(hash, "c2c-runtime-content-v1");
  for (const relative of [...inputs].sort()) {
    const file = path.join(sourceRoot, relative);
    try {
      fs.lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hashText(hash, "missing");
      hashText(hash, relative.split(path.sep).join("/"));
      continue;
    }
    hashContentEntry(hash, sourceRoot, file);
  }
  return hash.digest("hex");
}

function gitOutput(root: string, args: string[]): string | null {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 8_000,
    env: isolatedGitEnvironment(),
  });
  if (result.status !== 0) return null;
  const output = typeof result.stdout === "string" ? result.stdout.trim() : "";
  return output || null;
}

function gitWorktreeIsClean(root: string): boolean | null {
  const result = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
    timeout: 8_000,
    env: isolatedGitEnvironment(),
  });
  if (result.status !== 0) return null;
  const output = typeof result.stdout === "string" ? result.stdout : "";
  return output.trim() === "";
}

function canonicalPath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function remoteTip(repository: string, ref: string): string | null {
  const result = spawnSync("git", ["ls-remote", repository, ref], {
    encoding: "utf8",
    timeout: 8_000,
    env: isolatedGitEnvironment(),
  });
  if (result.status !== 0) return null;
  const line = (typeof result.stdout === "string" ? result.stdout : "").trim().split(/\r?\n/, 1)[0] ?? "";
  const revision = line.split(/\s+/, 1)[0];
  return validRevision(revision) ? revision.toLowerCase() : null;
}

function remoteDefaultRef(repository: string): string | null {
  const result = spawnSync("git", ["ls-remote", "--symref", repository, "HEAD"], {
    encoding: "utf8",
    timeout: 8_000,
    env: isolatedGitEnvironment(),
  });
  if (result.status !== 0) return null;
  const output = typeof result.stdout === "string" ? result.stdout : "";
  const match = /^ref: (refs\/heads\/[^\s]+)\s+HEAD$/m.exec(output);
  return match?.[1] ?? null;
}

function localRemoteDefaultRef(root: string): string | null {
  const symbolicRef = gitOutput(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  const prefix = "refs/remotes/origin/";
  if (!symbolicRef?.startsWith(prefix)) return null;
  const branch = symbolicRef.slice(prefix.length);
  return branch ? `refs/heads/${branch}` : null;
}

function sourceRef(root: string, repository: string): string | null {
  // The runtime must follow a durable branch, not whichever short-lived
  // feature branch happened to produce the installed commit.
  return remoteDefaultRef(repository) ?? localRemoteDefaultRef(root);
}

export function collectSourceMetadata(
  root: string,
  contentInputs: readonly string[] = [],
  /** Use a separately verified build tree when package inputs are generated. */
  contentRoot: string = root,
): SourceMetadata {
  const gitRoot = gitOutput(root, ["rev-parse", "--show-toplevel"]);
  const isCheckoutRoot = gitRoot !== null && canonicalPath(gitRoot) === canonicalPath(root);
  if (isCheckoutRoot) {
    const clean = gitWorktreeIsClean(root);
    if (clean === null) throw new Error("unable to inspect runtime source checkout state");
    if (!clean) {
      throw new Error("runtime source checkout must be clean before installation");
    }
  }
  const revision = isCheckoutRoot ? gitOutput(root, ["rev-parse", "--verify", "HEAD^{commit}"]) : null;
  const normalizedRevision = validRevision(revision) ? revision.toLowerCase() : null;
  const repository = isCheckoutRoot
    ? sanitizeRepository(gitOutput(root, ["remote", "get-url", "origin"]))
    : null;
  const ref = repository ? sourceRef(root, repository) : null;
  if (repository && !ref) {
    throw new Error("runtime source remote default branch could not be determined");
  }
  return {
    schemaVersion: 1,
    revision: normalizedRevision,
    repository,
    ref,
    baselineRemoteRevision: repository && ref ? remoteTip(repository, ref) : null,
    contentDigest: computeContentDigest(contentRoot, contentInputs),
  };
}
