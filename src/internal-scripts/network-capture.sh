#!/bin/bash
# scripts/network-capture.sh

echo "[Network] WSL capture started on interface eth0..."

# Use eth0 (common WSL interface). Change if needed.
tcpdump -i eth0 -nn -tttt -q 2>&1