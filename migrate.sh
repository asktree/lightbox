#!/usr/bin/env bash
# Migrate musicbox/lightbox state between Macs.
#
#   ./migrate.sh push <user@host>      # transfer TO destination (run on source)
#   ./migrate.sh setup                 # rebuild venvs + install madmom (run on dest)
#   ./migrate.sh secure <user@host>    # harden dest sshd (key-only, no password)
#
# Before push: on destination Mac, enable Remote Login:
#   System Settings → General → Sharing → Remote Login → on
#   (optionally restrict to your user via the ⓘ menu)
#
# `push` will auto-generate an SSH key and install it on destination via
# ssh-copy-id — you'll be prompted for password *once*, after that rsync uses
# key auth. Run `secure` afterward to disable password logins entirely.
#
# Over a gigabit LAN this takes ~5 minutes for a ~24 GB library.
# rsync is resumable — re-run if interrupted.

set -euo pipefail

REPO="$HOME/Coding/lightbox"
LIBRARY="$HOME/music-library"
MUSICBOX_CONFIG="$HOME/.config/musicbox"
ZOTIFY_STATE="$HOME/Library/Application Support/Zotify"

# SSH options: use only our specific key (prevents "Too many authentication
# failures" when the agent has lots of keys). Applied to every ssh/rsync call.
SSH_KEY="$HOME/.ssh/id_ed25519"
SSH_BASE="ssh -i $SSH_KEY -o IdentitiesOnly=yes"

cmd="${1:-}"

ensure_ssh_key() {
  local key="$HOME/.ssh/id_ed25519"
  if [[ ! -f "$key" ]]; then
    echo "→ no ssh key at $key — generating one..."
    mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
    ssh-keygen -t ed25519 -N "" -f "$key" -C "$USER@$(hostname -s) (lightbox-migrate)"
    echo "✓ created $key"
  fi
}

ensure_key_on_remote() {
  local dst="$1"
  # Try key-only auth first. If it works, we're done.
  if $SSH_BASE -o BatchMode=yes -o ConnectTimeout=5 \
        -o PreferredAuthentications=publickey \
        "$dst" true 2>/dev/null; then
    return 0
  fi

  # First-time connection: auto-accept the host key so ssh-copy-id doesn't
  # fail with "Host key verification failed". This uses accept-new which is
  # safe on first contact and strict on subsequent connections.
  echo "→ accepting host key for $dst..."
  ssh -o StrictHostKeyChecking=accept-new \
      -o PubkeyAuthentication=no \
      -o PasswordAuthentication=no \
      -o KbdInteractiveAuthentication=no \
      -o ConnectTimeout=5 \
      "$dst" true 2>/dev/null || true   # we expect this to fail auth; we just wanted the host key

  # Now push our public key. Prompts for password once.
  # IdentitiesOnly + explicitly setting which keys to offer prevents "Too many
  # authentication failures" when your ssh-agent has lots of keys loaded.
  echo "→ installing public key on $dst (one-time password prompt)..."
  ssh-copy-id -o StrictHostKeyChecking=accept-new \
              -o IdentitiesOnly=yes \
              -o PreferredAuthentications=password,keyboard-interactive \
              -i "$HOME/.ssh/id_ed25519.pub" "$dst"
}

push() {
  local dst="${1:-}"
  if [[ -z "$dst" ]]; then
    echo "usage: $0 push <user@host>" >&2
    echo "  e.g., $0 push em@other-mac.local" >&2
    exit 1
  fi

  ensure_ssh_key
  ensure_key_on_remote "$dst"

  # Pre-flight: key auth should now work unattended
  echo "→ verifying key-based ssh access to $dst..."
  if ! ssh -o BatchMode=yes -o ConnectTimeout=5 \
          -o PreferredAuthentications=publickey \
          "$dst" true 2>/dev/null; then
    echo "❌ key auth to $dst still not working"
    echo "   Make sure Remote Login is enabled on the destination:"
    echo "   System Settings → General → Sharing → Remote Login"
    exit 1
  fi
  echo "✓ key auth working"

  # Ensure target parent directories exist on destination
  $SSH_BASE "$dst" '
    mkdir -p "$HOME/Coding" \
             "$HOME/.config" \
             "$HOME/Library/Application Support/Zotify"
  '

  # -a = archive. No -z: our audio (OGG) is already compressed, so rsync's
  # gzip just burns CPU. Text files (source code, JSON) would compress but
  # we skip that small win to keep the big library transfer fast.
  # whole-file mode (-W) avoids the rsync delta algorithm which is pointless
  # for files that don't already exist on the destination.
  echo ""
  echo "→ [1/4] repo (excluding node_modules, venvs, build artifacts)..."
  rsync -a --progress --partial --rsh="$SSH_BASE" \
    --exclude=node_modules \
    --exclude=.venv \
    --exclude=.venv-essentia \
    --exclude=dist \
    --exclude=.next \
    --exclude=__pycache__ \
    --exclude=.DS_Store \
    "$REPO/" "$dst:Coding/lightbox/"

  echo ""
  echo "→ [2/4] music library (big one — grab a coffee)..."
  rsync -aW --progress --partial --rsh="$SSH_BASE" \
    "$LIBRARY/" "$dst:music-library/"

  echo ""
  echo "→ [3/4] musicbox credentials..."
  rsync -a --progress --rsh="$SSH_BASE" \
    "$MUSICBOX_CONFIG/" "$dst:.config/musicbox/"

  echo ""
  echo "→ [4/4] zotify device token..."
  rsync -a --progress --rsh="$SSH_BASE" \
    "$ZOTIFY_STATE/" "$dst:Library/Application Support/Zotify/"

  echo ""
  echo "✅ done. On the destination machine, run:"
  echo "     cd ~/Coding/lightbox && ./migrate.sh setup"
}

setup() {
  # Guard: make sure we're on the destination machine (we have a library but no venvs yet)
  if [[ ! -d "$LIBRARY" ]]; then
    echo "❌ $LIBRARY not found — did the rsync complete? Run 'push' from the source Mac first."
    exit 1
  fi

  cd "$REPO"

  echo "→ pnpm install..."
  if command -v pnpm >/dev/null 2>&1; then
    pnpm install
  else
    echo "⚠️  pnpm not installed. Install with: npm i -g pnpm"
  fi

  cd "$REPO/packages/music-scraper"

  echo ""
  echo "→ main venv (torch, demucs, librosa, beat-this)..."
  python3 -m venv .venv
  .venv/bin/pip install --quiet --upgrade pip
  .venv/bin/pip install --quiet -r requirements.txt
  # Extras added post-requirements.txt
  .venv/bin/pip install --quiet \
    'git+https://github.com/DraftKinner/zotify' \
    torchcodec certifi

  echo ""
  echo "→ essentia sidecar venv (numpy<2 world, + madmom)..."
  python3 -m venv .venv-essentia
  .venv-essentia/bin/pip install --quiet --upgrade pip
  .venv-essentia/bin/pip install --quiet 'numpy<2' essentia madmom cython

  echo ""
  echo "→ verifying everything imports..."
  .venv/bin/python -c "
import torch, librosa, demucs.pretrained
print(f'  torch {torch.__version__}')
print(f'  librosa {librosa.__version__}')
print(f'  demucs: OK')
" || echo "  ⚠ main venv has issues"
  .venv-essentia/bin/python -c "
import essentia.standard as es, madmom
print(f'  essentia {es.__version__ if hasattr(es, \"__version__\") else \"installed\"}')
print(f'  madmom {madmom.__version__}')
" || echo "  ⚠ essentia venv has issues"

  echo ""
  echo "✅ setup done."
  echo ""
  echo "Next:"
  echo "  - Test a download:   .venv/bin/python -m scraper status"
  echo "  - Re-analyze a track:  .venv/bin/python -c \"...\""
  echo "  - Start musicbox:    cd $REPO && pnpm musicbox"
  echo ""
  echo "Note: Demucs will download the htdemucs model (~200MB) on its first run."
}

secure() {
  local dst="${1:-}"
  if [[ -z "$dst" ]]; then
    echo "usage: $0 secure <user@host>" >&2
    exit 1
  fi

  # Safety check: confirm key auth is working BEFORE we disable passwords
  echo "→ verifying key auth still works..."
  if ! $SSH_BASE -o BatchMode=yes -o ConnectTimeout=5 \
          -o PreferredAuthentications=publickey \
          "$dst" true 2>/dev/null; then
    echo "❌ key auth isn't working. NOT disabling password auth (would lock you out)."
    echo "   Run: $0 push $dst   first, then try this again."
    exit 1
  fi
  echo "✓ key auth confirmed"

  echo "→ installing sshd drop-in on $dst to disable password auth..."
  # shellcheck disable=SC2087
  $SSH_BASE -t "$dst" 'sudo bash -s' <<'REMOTE'
set -e
CONF=/etc/ssh/sshd_config.d/10-lightbox-harden.conf
cat <<EOF | sudo tee "$CONF" >/dev/null
# installed by lightbox migrate.sh
PasswordAuthentication no
ChallengeResponseAuthentication no
KbdInteractiveAuthentication no
UsePAM no
EOF
sudo chmod 644 "$CONF"
echo "wrote $CONF"
sudo launchctl kickstart -k system/com.openssh.sshd
echo "sshd reloaded"
REMOTE

  echo ""
  echo "✅ password auth disabled on $dst."
  echo "   Only your ssh key can log in now. Keep ~/.ssh/id_ed25519 safe!"
  echo ""
  echo "   If you ever get locked out, you can re-enable password auth on the"
  echo "   Mac console by deleting /etc/ssh/sshd_config.d/10-lightbox-harden.conf"
  echo "   and running: sudo launchctl kickstart -k system/com.openssh.sshd"
}

case "$cmd" in
  push)   shift; push "$@" ;;
  setup)  setup ;;
  secure) shift; secure "$@" ;;
  *)
    echo "usage:"
    echo "  $0 push <user@host>     # on source: transfer to dest"
    echo "  $0 setup                # on dest: rebuild venvs + install madmom"
    echo "  $0 secure <user@host>   # on source: disable password auth on dest (key-only)"
    exit 1
    ;;
esac
