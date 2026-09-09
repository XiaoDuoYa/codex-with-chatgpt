const moduleSource = `
const runtimePath = process.env.C2C_TEST_RUNTIME_PATH;
if (!runtimePath) throw new Error("C2C test runtime path is missing");

export function installRuntime() {
  return { installed: true, changed: false, path: runtimePath };
}

export function restoreRuntimeInstallation() {
  throw new Error("unexpected runtime restore in Skill CLI test");
}

export function runtimeCurrentPath() {
  return runtimePath;
}

export function runtimeEntryPath() {
  return runtimePath;
}

export function snapshotRuntimeInstallation() {
  throw new Error("unexpected runtime snapshot in Skill CLI test");
}
`;

const replacementUrl = `data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`;

export async function resolve(specifier, context, nextResolve) {
  if (/runtime-install\.(?:ts|js)$/.test(specifier)) {
    return { shortCircuit: true, url: replacementUrl };
  }
  return nextResolve(specifier, context);
}
