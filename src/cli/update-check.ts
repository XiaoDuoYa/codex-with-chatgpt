/** A local descendant of upstream is not an available upstream update. */
export function upstreamUpdateAvailable(
  localCommit: string,
  remoteCommit: string,
  remoteIsAncestorOfLocal: (remote: string, local: string) => boolean,
): boolean {
  return remoteCommit !== localCommit && !remoteIsAncestorOfLocal(remoteCommit, localCommit);
}
