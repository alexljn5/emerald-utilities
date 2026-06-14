#!/bin/bash
IFACE="${1:-any}"

echo "[Network] Capture started on interface: $IFACE"
echo "[Network] tcpdump PID: $$"

# Run tcpdump. Native Linux can use tcpdump directly; WSL/Windows shells keep stdbuf.
if [[ "$(uname -s)" == "Linux" ]]; then
  exec tcpdump -i "$IFACE" -nn -tttt -l -q 2>&1
fi

exec stdbuf -oL tcpdump -i "$IFACE" -nn -tttt -l -q 2>&1