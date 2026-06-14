#!/usr/bin/env bash

set -euo pipefail

INTERFACE="${1:-any}"
FILTER="${2:-}"

exec /usr/sbin/tcpdump \
  -i "$INTERFACE" \
  -nn \
  -ttt \
  -q \
  $FILTER