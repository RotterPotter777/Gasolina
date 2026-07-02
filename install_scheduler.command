#!/bin/zsh
set -euo pipefail

LABEL="com.rotterpotter.gasolina-update"
SOURCE_REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$HOME/Library/Application Support/Gasolina"
REPO_DIR="$APP_DIR/repo"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"
USER_DOMAIN="gui/$(id -u)"

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$APP_DIR"

GITHUB_IP=$(/usr/bin/python3 -c 'import socket; print(socket.gethostbyname("github.com"))')
export GIT_SSH_COMMAND="ssh -o HostName=${GITHUB_IP} -o HostKeyAlias=github.com -o UpdateHostKeys=no"

if [[ -d "$REPO_DIR/.git" ]]; then
  git -C "$REPO_DIR" pull --ff-only origin main
else
  git clone git@github.com:RotterPotter777/Gasolina.git "$REPO_DIR"
fi

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>${REPO_DIR}/update_data.command</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${REPO_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>10800</integer>
  <key>StandardOutPath</key>
  <string>${APP_DIR}/update_data.log</string>
  <key>StandardErrorPath</key>
  <string>${APP_DIR}/update_data_error.log</string>
</dict>
</plist>
EOF

chmod 600 "$PLIST_PATH"
launchctl bootout "$USER_DOMAIN" "$PLIST_PATH" 2>/dev/null || true
launchctl bootstrap "$USER_DOMAIN" "$PLIST_PATH"
launchctl kickstart -k "${USER_DOMAIN}/${LABEL}"

echo
echo "Автообновление Gasolina установлено и запущено."
echo "Периодичность: каждые 3 часа."
echo "Рабочая копия: ${REPO_DIR}"
echo "Журнал: ${APP_DIR}/update_data.log"
