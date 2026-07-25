#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
cd "$SCRIPT_DIR"

echo "Codex 两边会话同步"
echo "会跳过归档会话；同步前会自动备份。"
echo

if [[ -x "$HOME/local/node/bin/node" ]]; then
  NODE="$HOME/local/node/bin/node"
elif [[ -x "/Applications/Codex.app/Contents/Resources/cua_node/bin/node" ]]; then
  NODE="/Applications/Codex.app/Contents/Resources/cua_node/bin/node"
else
  NODE=$(command -v node)
fi
"$NODE" "$SCRIPT_DIR/sync_codex_sessions.js"

echo
echo "完成。可以关闭这个窗口。"
read -k 1 -s "?按任意键关闭..."
