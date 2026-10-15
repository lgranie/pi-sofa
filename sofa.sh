#!/usr/bin/env bash
# Launch pi as the sofa orchestrator, in the current directory, in its own herdr session.
# Usage: sofa.sh [session]   (default session: sofa)
set -euo pipefail

session="${1:-sofa}"
ext="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/extensions/sofa/index.ts"
h() { herdr --session "$session" "$@"; }
up() { h workspace list 2>/dev/null | grep -q '"result"'; }

if ! up; then
  nohup herdr --session "$session" server >/dev/null 2>&1 &
  for _ in $(seq 50); do up && break; sleep 0.2; done
  up || { echo "herdr session '$session' did not start" >&2; exit 1; }
fi

# root_pane is the first pane_id in the create response
pane=$(h workspace create --cwd "$PWD" --label "$(basename "$PWD")" --focus | grep -o '"pane_id":"[^"]*"' | head -n1 | cut -d'"' -f4)
h pane run "$pane" "mise x pi -- pi -e \"$ext\" -e git:github.com/lgranie/pi-decision-provider" >/dev/null
exec herdr session attach "$session"
