const moduleSource = `
const hashes = JSON.parse(process.env.C2C_TEST_TUNNEL_HASHES_JSON ?? "null");
if (!hashes?.archive || !hashes?.binary) {
  throw new Error("C2C test tunnel hashes are missing");
}
export const OPENAI_TUNNEL_ARCHIVE_SHA256 = Object.freeze(hashes.archive);
export const OPENAI_TUNNEL_BINARY_SHA256 = Object.freeze(hashes.binary);
`;

const replacementUrl = `data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`;

export async function resolve(specifier, context, nextResolve) {
  if (/openai-secure-hashes\.(?:ts|js)$/.test(specifier)) {
    return { shortCircuit: true, url: replacementUrl };
  }
  return nextResolve(specifier, context);
}
