import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_NAME = "codex-with-chatgpt";
const PLACEHOLDER = "<ACTUAL_CHECKOUT_PATH>";
const SKILL_RELATIVE_PATH = path.join("skill", "SKILL.md");

export interface SkillInstallOptions {
  /** Checkout containing the source skill. Defaults to this package checkout. */
  checkoutRoot?: string;
  /** Codex home used for the destination. Defaults to CODEX_HOME or ~/.codex. */
  codexHome?: string;
}

export interface SkillInstallResult {
  installed: true;
  changed: boolean;
  path: string;
  contentHash: string;
  sourcePath: string;
  checkoutRoot: string;
}

export interface SkillStatusResult {
  installed: boolean;
  matches: boolean;
  path: string;
  contentHash: string | null;
  expectedContentHash: string;
  sourcePath: string;
  checkoutRoot: string;
}

export interface SkillInstallSnapshot {
  readonly codexHome: string;
  readonly path: string;
  readonly previous: { readonly kind: "missing" } | {
    readonly kind: "file";
    readonly bytes: Buffer;
    readonly mode: number;
  };
}

export function getSkillCheckoutRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function getSkillInstallPath(codexHome?: string): string {
  return path.join(resolveCodexHome(codexHome), "skills", SKILL_NAME, "SKILL.md");
}

export function renderSkill(source: string, checkoutRoot: string): string {
  const count = source.split(PLACEHOLDER).length - 1;
  if (count === 0) {
    throw new Error(`Skill source must contain exactly one ${PLACEHOLDER} placeholder`);
  }
  if (count !== 1) {
    throw new Error(`Skill source contains ${count} ${PLACEHOLDER} placeholders; exactly one is required`);
  }
  return source.replace(PLACEHOLDER, checkoutRoot);
}

export function installGlobalSkill(options: SkillInstallOptions = {}): SkillInstallResult {
  const sourceInfo = readSkillSource(options.checkoutRoot);
  const rendered = renderSkill(sourceInfo.content, sourceInfo.checkoutRoot);
  const contentHash = hashContent(rendered);
  const target = getSkillInstallPath(options.codexHome);
  const targetDir = path.dirname(target);

  ensureSafeDirectory(path.dirname(targetDir));
  ensureSafeDirectory(targetDir);

  let changed = true;
  const existing = readSafeTarget(target);
  if (existing !== null && existing.content === rendered) {
    changed = false;
    chmodOwnerOnly(target, 0o600);
  } else {
    writeAtomicSkill(target, rendered);
  }

  return {
    installed: true,
    changed,
    path: target,
    contentHash,
    sourcePath: sourceInfo.sourcePath,
    checkoutRoot: sourceInfo.checkoutRoot,
  };
}

/** Capture the global Skill target before a multi-step machine setup. */
export function snapshotGlobalSkill(options: SkillInstallOptions = {}): SkillInstallSnapshot {
  const codexHome = resolveCodexHome(options.codexHome);
  const target = getSkillInstallPath(codexHome);
  const existing = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!existing) return { codexHome, path: target, previous: { kind: "missing" } };
  if (existing.isSymbolicLink()) throw new Error(`Refusing to snapshot symlink Skill target: ${target}`);
  if (!existing.isFile()) throw new Error(`Skill target is not a regular file: ${target}`);
  return {
    codexHome,
    path: target,
    previous: { kind: "file", bytes: fs.readFileSync(target), mode: existing.mode & 0o777 },
  };
}

/** Restore the global Skill target captured by snapshotGlobalSkill. */
export function restoreGlobalSkill(snapshot: SkillInstallSnapshot): void {
  const target = getSkillInstallPath(snapshot.codexHome);
  if (target !== snapshot.path) throw new Error("Skill rollback target does not match its snapshot");
  ensureSafeDirectory(path.dirname(path.dirname(target)));
  const existing = fs.lstatSync(target, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) throw new Error(`Refusing to overwrite symlink Skill target: ${target}`);
  fs.rmSync(target, { force: true });
  if (snapshot.previous.kind === "missing") return;
  fs.writeFileSync(target, snapshot.previous.bytes, { mode: snapshot.previous.mode });
  chmodOwnerOnly(target, snapshot.previous.mode);
}

export function statusGlobalSkill(options: SkillInstallOptions = {}): SkillStatusResult {
  const sourceInfo = readSkillSource(options.checkoutRoot);
  const rendered = renderSkill(sourceInfo.content, sourceInfo.checkoutRoot);
  const target = getSkillInstallPath(options.codexHome);
  const targetDir = path.dirname(target);
  const parentSafe = assertSafeDirectory(path.dirname(targetDir));
  const targetDirSafe = parentSafe && assertSafeDirectory(targetDir);
  const existing = targetDirSafe ? readSafeTarget(target, { allowMissing: true }) : null;
  const contentHash = existing === null ? null : hashContent(existing.content);
  const expectedContentHash = hashContent(rendered);
  return {
    installed: existing !== null,
    matches: existing !== null && existing.content === rendered,
    path: target,
    contentHash,
    expectedContentHash,
    sourcePath: sourceInfo.sourcePath,
    checkoutRoot: sourceInfo.checkoutRoot,
  };
}

function resolveCodexHome(override?: string): string {
  const configured = override?.trim() || process.env.CODEX_HOME?.trim();
  return path.resolve(configured || path.join(os.homedir(), ".codex"));
}

function readSkillSource(checkoutRootOption?: string): {
  checkoutRoot: string;
  sourcePath: string;
  content: string;
} {
  const checkoutRoot = path.resolve(checkoutRootOption ?? getSkillCheckoutRoot());
  const sourcePath = path.join(checkoutRoot, SKILL_RELATIVE_PATH);
  const stat = fs.lstatSync(sourcePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Skill source is not a regular file: ${sourcePath}`);
  }
  return { checkoutRoot, sourcePath, content: fs.readFileSync(sourcePath, "utf8") };
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function ensureSafeDirectory(directory: string): void {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  for (const segment of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`Skill install path contains a symlink: ${current}`);
      if (!stat.isDirectory()) throw new Error(`Skill install path is not a directory: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      fs.mkdirSync(current, { mode: 0o700 });
      const created = fs.lstatSync(current);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new Error(`Skill install path is unsafe: ${current}`);
      }
    }
  }
  chmodOwnerOnly(absolute, 0o700);
}

function assertSafeDirectory(directory: string): boolean {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  for (const segment of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`Skill install path contains a symlink: ${current}`);
      if (!stat.isDirectory()) throw new Error(`Skill install path is not a directory: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return true;
}

function readSafeTarget(
  target: string,
  options: { allowMissing?: boolean } = {},
): { content: string } | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && options.allowMissing !== false) return null;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`Refusing to use symlink Skill target: ${target}`);
  if (!stat.isFile()) throw new Error(`Skill target is not a regular file: ${target}`);
  return { content: fs.readFileSync(target, "utf8") };
}

function writeAtomicSkill(target: string, content: string): void {
  const existing = readSafeTarget(target, { allowMissing: true });
  if (existing !== null && existing.content === content) return;

  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, content, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const beforeRename = readSafeTarget(target, { allowMissing: true });
    if (beforeRename !== null && beforeRename.content === content) return;
    fs.renameSync(temporary, target);
    chmodOwnerOnly(target, 0o600);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function chmodOwnerOnly(file: string, mode: number): void {
  try {
    fs.chmodSync(file, mode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOTSUP" &&
        (error as NodeJS.ErrnoException).code !== "EPERM") {
      throw error;
    }
  }
}
