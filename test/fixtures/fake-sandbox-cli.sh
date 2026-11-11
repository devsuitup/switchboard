#!/usr/bin/env bash
STAT=$(</proc/$$/stat)
read -r -a F <<<"${STAT##*) }"
START=${F[19]}
DIR="$HOME/.claude/sessions"
mkdir -p "$DIR"
if [ -n "$FAKE_MISMATCH" ]; then START=$((START + 1)); fi
desc() {
  printf '{"pid":%d,"sessionId":"%s","kind":"interactive","status":"%s","statusUpdatedAt":%d,"procStart":"%s","cwd":"%s"}\n' \
    $$ "$FAKE_ID" "$1" "$(date +%s%3N)" "$START" "$PWD" > "$DIR/$$.json.tmp" && mv "$DIR/$$.json.tmp" "$DIR/$$.json"
}
sleep 0.3; desc busy
sleep 0.3; desc idle
stty raw -echo 2>/dev/null
while IFS= read -r -s -n1 -d '' ch; do
  if [ "$ch" = $'\r' ] || [ "$ch" = $'\n' ]; then
    echo ENTER >> "$FAKE_LOG"; desc busy; sleep 0.1; desc idle
  else
    printf '%s' "$ch" >> "$FAKE_LOG"
  fi
done
