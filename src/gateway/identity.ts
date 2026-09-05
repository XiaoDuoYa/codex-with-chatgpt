import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  ensureDir,
  getStateDir,
  readJsonIfExists,
  withFileLock,
  writeSecureJsonExclusive,
} from "../config/paths.js";

const machineIdentitySchema = z
  .object({
    schemaVersion: z.literal(1),
    machineId: z.string().regex(/^machine-[a-f0-9]{32}$/),
    createdAt: z.string().datetime(),
  })
  .strict();

export type MachineIdentity = z.infer<typeof machineIdentitySchema>;

export function machineIdentityFile(): string {
  return path.join(ensureDir(path.join(getStateDir(), "machine")), "identity.json");
}

function readIdentity(file: string): MachineIdentity | null {
  const value = readJsonIfExists<unknown>(file);
  if (value === null) {
    if (fs.existsSync(file)) throw new Error("machine identity is unreadable or malformed");
    return null;
  }
  const parsed = machineIdentitySchema.safeParse(value);
  if (!parsed.success) throw new Error("machine identity failed validation");
  return parsed.data;
}

/** Stable, owner-only identity for the single machine-scoped connector. */
export function resolveMachineIdentity(): MachineIdentity {
  const file = machineIdentityFile();
  const lock = path.join(path.dirname(file), "identity.lock");
  return withFileLock(lock, () => {
    const existing = readIdentity(file);
    if (existing) return existing;

    const created: MachineIdentity = {
      schemaVersion: 1,
      machineId: `machine-${randomBytes(16).toString("hex")}`,
      createdAt: new Date().toISOString(),
    };
    try {
      writeSecureJsonExclusive(file, created);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const published = readIdentity(file);
    if (!published) throw new Error("machine identity could not be created");
    return published;
  });
}
