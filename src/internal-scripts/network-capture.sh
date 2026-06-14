#!/bin/bash
IFACE="${1:-any}"
echo "[Network] Capture started on interface: $IFACE"
echo "[Network] tcpdump PID: $$"

# Run tcpdump and ensure output is line-buffered
exec stdbuf -oL tcpdump -i "$IFACE" -nn -tttt -l -q 2>&1