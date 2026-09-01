#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ -n "${C2C_NODE:-}" ]; then
  NODE="$C2C_NODE"
elif command -v node >/dev/null 2>&1; then
  NODE=$(command -v node)
elif [ -x "$HOME/.local/share/codex-with-chatgpt/node-v24.19.0-darwin-arm64/bin/node" ]; then
  NODE="$HOME/.local/share/codex-with-chatgpt/node-v24.19.0-darwin-arm64/bin/node"
elif [ -x "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" ]; then
  NODE="/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"
else
  printf '%s\n' 'Node.js 20 以上が必要です。C2C_NODE または PATH の node を設定してください。' >&2
  exit 1
fi

case "$(uname -s)" in
  Darwin)
    DEFAULT_STATE_DIR="$HOME/Library/Application Support/codex-with-chatgpt"
    ;;
  *)
    DEFAULT_STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/codex-with-chatgpt"
    ;;
esac

STATE_DIR="${C2C_STATE_DIR:-$DEFAULT_STATE_DIR}"
export C2C_STATE_DIR="$STATE_DIR"
# upstream の sandbox-allow は Codex 用。OMP では既存の ~/.codex を変更せず、
# C2C 状態ディレクトリ配下の隔離設定だけを使う。
export CODEX_HOME="${C2C_OMP_CODEX_HOME:-$STATE_DIR/omp-codex-home}"

exec "$NODE" "$SCRIPT_DIR/../bin/c2c.js" "$@"
