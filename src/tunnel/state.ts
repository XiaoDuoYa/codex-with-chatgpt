import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";

export type TunnelPreference = "unset" | "quick" | "named";

export interface TunnelState {
  workspaceId: string;
  preference: TunnelPreference;
  askedAt?: string;
  provider?: "cloudflare-quick" | "cloudflare-named";
  tunnelName?: string;
  tunnelId?: string;
  credentialsFile?: string;
  hostname?: string;
  zone?: string;
  configuredAt?: string;
  fallbackReason?: string;
}

export function tunnelStateFile(workspaceId: string): string {
  return path.join(getStateDir(), "tunnels", `${workspaceId}.json`);
}

export function readTunnelState(workspaceId: string): TunnelState {
  return (
    readJsonIfExists<TunnelState>(tunnelStateFile(workspaceId)) ?? {
      workspaceId,
      preference: "unset",
    }
  );
}

export function writeTunnelState(state: TunnelState): TunnelState {
  writeSecureJson(tunnelStateFile(state.workspaceId), state);
  return state;
}

export function needsTunnelChoice(state: TunnelState): boolean {
  return state.preference === "unset" || !state.askedAt;
}

export function isNamedTunnelReady(state: TunnelState): boolean {
  return (
    state.preference === "named" &&
    Boolean(state.tunnelName?.trim()) &&
    Boolean(state.hostname?.trim())
  );
}

export function namedTunnelBinding(state: TunnelState): { tunnelName: string; hostname: string; tunnelId?: string; credentialsFile?: string } | null {
  if (!isNamedTunnelReady(state) || !state.tunnelName || !state.hostname) return null;
  return { tunnelName: state.tunnelName, hostname: state.hostname, tunnelId: state.tunnelId, credentialsFile: state.credentialsFile };
}

/** A live Bridge fixes its tunnel provider when it starts. Disk state alone
 * cannot change that provider, so setup must replace a mismatched process. */
export function requiresTunnelRestart(state: TunnelState, provider: string, publicUrl: string | null): boolean {
  if (isNamedTunnelReady(state)) {
    if (provider !== "cloudflare-named") return true;
    return Boolean(publicUrl && publicUrl.replace(/\/+$/, "").toLowerCase() !== `https://${state.hostname!.toLowerCase()}`);
  }
  return provider === "cloudflare-named";
}

export const TUNNEL_CHOICE_PROMPT = `连 ChatGPT 之前，有一条可选的。
你有没有 Cloudflare 账号，并且有没有一个域名已经加在 Cloudflare 里？
- 有：可以用固定域名。插件配一次，以后电脑重启一般不用再改插件。要登录一次 Cloudflare，并在你的域名下加一个子域名。
- 没有：用临时地址。不用注册，功能一样。但电脑重启后地址常会变，ChatGPT 里的旧地址会失效。我会自己删掉这个项目的插件、用新地址再加回去，你偶尔要再登一下 ChatGPT。能修好，只是更慢。
没有账号也完全能用。你选哪个？如果有域名，直接告诉我域名（例如 example.com）。`;

export const NAMED_LOGIN_PROMPT =
  "会弹出浏览器，请登录 Cloudflare 并选中你的域名，完成后告诉我「好了」。";

export const NAMED_FALLBACK_MESSAGE =
  "这次先用临时地址。功能一样，以后修连接可能会更慢。想改成固定域名时再说一声。";

export const NAMED_REPAIR_MESSAGE =
  "固定域名暂时连不上。请在即将弹出的窗口登录 Cloudflare，选中你的域名，完成后告诉我「好了」。";
