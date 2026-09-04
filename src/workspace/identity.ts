import fs from "node:fs";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { runGit } from "./git.js";
import { writeSecureJsonExclusive } from "../config/paths.js";

const GIT_PROJECT_ID_PATTERN = /^git-[a-f0-9]{32}$/;
const PROJECT_ID_METADATA = "c2c-project-id";

interface ProjectIdMetadata {
  version: 1;
  projectId: string;
}

function pathFallback(root: string): string {
  return `path-${createHash("sha256").update(root).digest("hex").slice(0, 32)}`;
}

/** Resolve Git's shared metadata directory, including linked worktrees. */
export function projectIdMetadataPath(root: string): string | null {
  const result = runGit(root, ["rev-parse", "--git-common-dir"]);
  if (!result.ok) return null;
  const raw = result.stdout.trim();
  if (!raw) return null;
  const candidate = path.resolve(root, raw);
  try {
    const commonDir = fs.realpathSync.native(candidate);
    if (!fs.statSync(commonDir).isDirectory()) return null;
    return path.join(commonDir, PROJECT_ID_METADATA);
  } catch {
    return null;
  }
}

function readMetadata(file: string): string | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ProjectIdMetadata>;
    if (parsed.version !== 1 || typeof parsed.projectId !== "string" || !GIT_PROJECT_ID_PATTERN.test(parsed.projectId)) {
      return null;
    }
    return parsed.projectId;
  } catch {
    return null;
  }
}

function newGitProjectId(): string {
  return `git-${randomBytes(16).toString("hex")}`;
}

/**
 * Resolve a project identity without making it a prerequisite for workspace access.
 * Git repositories publish a random ID in the shared git directory so linked
 * worktrees share it while independent clones do not. Other cases use a clear,
 * deterministic path fallback.
 */
export function resolveProjectId(root: string): string {
  const metadataFile = projectIdMetadataPath(root);
  if (!metadataFile) return pathFallback(root);

  const existing = readMetadata(metadataFile);
  if (existing) return existing;

  const candidate = newGitProjectId();
  try {
    writeSecureJsonExclusive(metadataFile, { version: 1, projectId: candidate } satisfies ProjectIdMetadata);
  } catch {
    // The git directory may be read-only (or on a filesystem without hardlinks).
    // Project identity is advisory; retain the workspace's core functionality.
  }
  return readMetadata(metadataFile) ?? pathFallback(root);
}
