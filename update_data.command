#!/bin/zsh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_DIR"

export GIT_SSH_COMMAND="ssh -p 443 -o HostName=ssh.github.com -o HostKeyAlias=github.com -o UpdateHostKeys=no"

git pull --ff-only origin main

GDEBENZ_USE_CURL=1 /usr/bin/python3 outputs/gdebenz_parser.py \
  --all \
  --with-status \
  --status-from-stations \
  --with-real-count \
  --with-districts \
  --workers 8 \
  --district-cache "${TMPDIR:-/tmp}/gdebenz_district_cache.json" \
  --insecure-ssl \
  --allow-partial

git add \
  outputs/gdebenz_unified_status_realcount_districts.csv \
  outputs/gdebenz_unified_status_realcount_districts.json

if git diff --cached --quiet; then
  echo "Данные не изменились."
  exit 0
fi

git commit -m "Update gdebenz data"
git push origin main
