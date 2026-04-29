#!/usr/bin/env bash
set -euo pipefail

# ── Configuration ──────────────────────────────────────────────
VPS_HOST="${VPS_HOST:?Set VPS_HOST (e.g. user@your-server.com)}"
VPS_DIR="${VPS_DIR:-/opt/whataboutthisbook}"
LOCAL_DATA="${DATA_DIR:-$HOME/.whataboutthisbook}"

# ── Build ──────────────────────────────────────────────────────
echo "==> Building Next.js..."
npm run build

# ── Sync app ───────────────────────────────────────────────────
echo "==> Syncing app to $VPS_HOST:$VPS_DIR ..."
rsync -avz --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude .env.local \
  ./ "$VPS_HOST:$VPS_DIR/app/"

# ── Sync data directory (books, index, covers) ────────────────
echo "==> Syncing book data to $VPS_HOST:$VPS_DIR/data ..."
rsync -avz "$LOCAL_DATA/" "$VPS_HOST:$VPS_DIR/data/"

# ── Install deps & restart on VPS ─────────────────────────────
echo "==> Installing dependencies and restarting on VPS..."
ssh "$VPS_HOST" bash -s <<'REMOTE'
  set -euo pipefail
  cd /opt/whataboutthisbook/app

  npm ci --omit=dev

  # Create / update the env file
  cat > .env.local <<ENV
PUBLIC_MODE=true
DATA_DIR=/opt/whataboutthisbook/data
OLLAMA_HOST=http://127.0.0.1:11434
ENV

  # Restart via systemd (create the unit once manually)
  if systemctl is-active --quiet whataboutthisbook; then
    sudo systemctl restart whataboutthisbook
  else
    echo "Start the service manually or create a systemd unit:"
    echo "  cd /opt/whataboutthisbook/app && npm start"
  fi
REMOTE

echo "==> Deploy complete!"
