import fs from "node:fs";
import path from "node:path";
import { Workspace, WorkspaceError } from "./manager.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

export interface WorkspaceImage {
  path: string;
  sizeBytes: number;
  mimeType: string;
  data: string;
}

function hasImageSignature(buffer: Buffer, extension: string): boolean {
  if (extension === ".png") return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (extension === ".jpg" || extension === ".jpeg") return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (extension === ".gif") return ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"));
  if (extension === ".webp") return buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  if (extension === ".svg") {
    const text = buffer.toString("utf8");
    const unsafe = /<(?:script|foreignObject|iframe|object|embed)\b|\son[a-z]+\s*=|(?:href|src)\s*=\s*["']\s*(?:https?:|\/\/|javascript:|data:text\/html)|url\(\s*["']?(?:https?:|\/\/|data:)|@import\b|<!ENTITY\b/i;
    return /^\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(text) && !unsafe.test(text);
  }
  return false;
}

export async function readWorkspaceImage(workspace: Workspace, requested: string): Promise<WorkspaceImage> {
  const { abs, rel } = workspace.resolve(requested);
  const extension = path.extname(rel).toLowerCase();
  const mimeType = IMAGE_TYPES[extension];
  if (!mimeType) throw new WorkspaceError("BINARY_FILE", `Unsupported image type: ${rel}`);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(abs);
  } catch {
    throw new WorkspaceError("FILE_NOT_FOUND", `File not found: ${rel}`);
  }
  if (!stat.isFile()) throw new WorkspaceError("NOT_A_FILE", `Not a regular file: ${rel}`);
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new WorkspaceError("FILE_TOO_LARGE", `Image exceeds the 10 MiB read limit: ${rel}`);
  }
  const buffer = await fs.promises.readFile(abs);
  if (!hasImageSignature(buffer, extension)) {
    throw new WorkspaceError("BINARY_FILE", `File content does not match its image extension: ${rel}`);
  }
  return { path: rel, sizeBytes: stat.size, mimeType, data: buffer.toString("base64") };
}
