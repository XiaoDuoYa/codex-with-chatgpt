import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Workspace } from "../workspace/manager.js";

const MAX_MEDIA_BYTES = 512 * 1024 * 1024;
const MEDIA_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webm": "video/webm",
  ".webp": "image/webp",
};

export interface ImportedMediaAsset {
  sourcePath: string;
  destinationPath: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
}

function assertSignature(buffer: Buffer, extension: string): void {
  let valid = false;
  if (extension === ".png") valid = buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  else if (extension === ".jpg" || extension === ".jpeg") valid = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  else if (extension === ".gif") valid = ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"));
  else if (extension === ".webp") valid = buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  else if (extension === ".webm") valid = buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  else if (extension === ".mp4" || extension === ".mov") valid = buffer.subarray(4, 8).toString("ascii") === "ftyp";
  if (!valid) throw new Error(`Downloaded media content does not match ${extension}`);
}

function assertSafeSvg(text: string): void {
  if (!/^\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(text)) throw new Error("Downloaded file is not an SVG document");
  const unsafe = /<(?:script|foreignObject|iframe|object|embed)\b|\son[a-z]+\s*=|(?:href|src)\s*=\s*["']\s*(?:https?:|\/\/|javascript:|data:text\/html)|url\(\s*["']?(?:https?:|\/\/|data:)|@import\b|<!ENTITY\b/i;
  if (unsafe.test(text)) throw new Error("SVG contains active or externally loaded content and was not imported");
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

export async function importMediaAsset(opts: {
  workspaceRoot: string;
  sourcePath: string;
  destinationPath: string;
}): Promise<ImportedMediaAsset> {
  const workspace = new Workspace(opts.workspaceRoot);
  const source = fs.realpathSync.native(path.resolve(opts.sourcePath));
  const stat = fs.statSync(source);
  if (!stat.isFile()) throw new Error("Media source must be a regular file");
  if (stat.size === 0 || stat.size > MAX_MEDIA_BYTES) throw new Error("Media source must be between 1 byte and 512 MiB");

  const destination = workspace.resolve(opts.destinationPath);
  if (!destination.rel || destination.rel.endsWith("/")) throw new Error("A project-relative destination file is required");
  const extension = path.extname(destination.rel).toLowerCase();
  const mediaType = MEDIA_TYPES[extension];
  if (!mediaType) throw new Error(`Unsupported media destination type: ${extension || "none"}`);
  if (fs.existsSync(destination.abs)) throw new Error(`Destination already exists: ${destination.rel}`);

  if (extension === ".svg") {
    if (stat.size > 10 * 1024 * 1024) throw new Error("SVG exceeds the 10 MiB validation limit");
    assertSafeSvg(fs.readFileSync(source, "utf8"));
  } else {
    const fd = fs.openSync(source, "r");
    try {
      const header = Buffer.alloc(16);
      fs.readSync(fd, header, 0, header.length, 0);
      assertSignature(header, extension);
    } finally {
      fs.closeSync(fd);
    }
  }

  fs.mkdirSync(path.dirname(destination.abs), { recursive: true });
  await fs.promises.copyFile(source, destination.abs, fs.constants.COPYFILE_EXCL);
  return {
    sourcePath: source,
    destinationPath: destination.rel,
    mediaType,
    sizeBytes: stat.size,
    sha256: await sha256(destination.abs),
  };
}
