import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import path from "node:path";

const MAX_TUNNEL_BINARY_BYTES = 64 * 1024 * 1024;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Verify and extract one release binary. The installer supplies the trusted
 * hashes from source; callers cannot make installation accept a different
 * release because this helper has no filesystem or publication side effects.
 */
export function verifyAndExtractOpenAiTunnelArchive(
  archive: Uint8Array,
  expectedArchiveSha256: string,
  expectedBinarySha256: string,
  expectedBinaryName: string,
): Uint8Array {
  if (sha256(archive) !== expectedArchiveSha256) {
    throw new Error("OpenAI tunnel archive checksum mismatch");
  }

  let targetEntry: string | undefined;
  const extracted = unzipSync(archive, {
    filter: (entry) => {
      if (path.posix.basename(entry.name) !== expectedBinaryName) return false;
      if (targetEntry !== undefined) {
        throw new Error(`OpenAI tunnel archive contains duplicate ${expectedBinaryName} entries`);
      }
      if (
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        entry.size > MAX_TUNNEL_BINARY_BYTES ||
        !Number.isSafeInteger(entry.originalSize) ||
        entry.originalSize < 0 ||
        entry.originalSize > MAX_TUNNEL_BINARY_BYTES
      ) {
        throw new Error(`OpenAI tunnel ${expectedBinaryName} entry is unexpectedly large`);
      }
      targetEntry = entry.name;
      return true;
    },
  });
  if (targetEntry === undefined) throw new Error(`OpenAI tunnel archive does not contain ${expectedBinaryName}`);
  const binary = extracted[targetEntry];
  if (!binary || binary.byteLength > MAX_TUNNEL_BINARY_BYTES) {
    throw new Error(`OpenAI tunnel ${expectedBinaryName} entry is unexpectedly large`);
  }
  if (sha256(binary) !== expectedBinarySha256) {
    throw new Error("OpenAI tunnel binary checksum mismatch");
  }
  return binary;
}
