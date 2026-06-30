#!/bin/zsh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_DIR"

git pull --ff-only origin main

/usr/bin/python3 outputs/gdebenz_parser.py \
  --all \
  --with-status \
  --with-real-count \
  --with-districts \
  --workers 24 \
  --insecure-ssl

git add \
  outputs/gdebenz_unified_status_realcount_districts.csv \
  outputs/gdebenz_unified_status_realcount_districts.json

if git diff --cached --quiet; then
  echo "Данные не изменились."
  exit 0
fi

git commit -m "Update gdebenz data"
git push origin main
