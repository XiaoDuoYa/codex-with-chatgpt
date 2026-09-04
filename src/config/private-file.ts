import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface PrivateFileSnapshot {
  readonly bytes: Buffer;
  readonly mode: number;
}

function lstatPrivateFile(file: string): fs.Stats | null {
  const absolute = path.resolve(file);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Private file must not be a symbolic link: ${absolute}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Private file must be a regular file: ${absolute}`);
  }
  return stat;
}

export function snapshotPrivateFile(file: string): PrivateFileSnapshot | null {
  const absolute = path.resolve(file);
  const stat = lstatPrivateFile(absolute);
  if (!stat) return null;
  return { bytes: fs.readFileSync(absolute), mode: stat.mode & 0o777 };
}

export function restorePrivateFile(file: string, snapshot: PrivateFileSnapshot | null): void {
  const absolute = path.resolve(file);
  const current = lstatPrivateFile(absolute);
  if (!snapshot) {
    if (current) fs.unlinkSync(absolute);
    return;
  }

  const parent = path.dirname(absolute);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    parent,
    `.${path.basename(absolute)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let fd: number | null = null;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, snapshot.bytes);
    fs.fchmodSync(fd, snapshot.mode);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    // Recheck the target immediately before publication. Renaming the same-directory
    // temporary inode never follows a target symlink.
    lstatPrivateFile(absolute);
    fs.renameSync(temporary, absolute);
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // preserve the original error
      }
    }
    throw error;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
