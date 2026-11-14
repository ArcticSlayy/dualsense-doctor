#!/usr/bin/env bash
# Serve only public browser assets on loopback (a secure context for WebHID).
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$DIR/serve.py" "$@"
