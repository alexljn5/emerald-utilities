#!/bin/bash

IFACE="${1:-any}"
shift || true
EXTRA_TCPDUMP_ARGS=("$@")

TCPDUMP_ARGS=(
    -i "$IFACE"
    -nn
    -tttt
    -l
    -vvv
    -e
    -XX
    "${EXTRA_TCPDUMP_ARGS[@]}"
)

echo "[Network] Capture started on interface: $IFACE"
echo "[Network] tcpdump PID: $$"
echo "[Network] tcpdump args: -i $IFACE -nn -tttt -l -vvv -e -XX ${EXTRA_TCPDUMP_ARGS[*]}"

for arg in "${EXTRA_TCPDUMP_ARGS[@]}"; do
    if [[ "$arg" == "-i" || "$arg" == "--interface" ]]; then
        echo "[Network] Warning: extra interface arguments are passed after the selected interface and may override it."
        break
    fi
done

if ! command -v tcpdump >/dev/null 2>&1; then
    echo "[Network] tcpdump not found. Install tcpdump in the active Linux/WSL environment." >&2
    exit 127
fi

run_tcpdump() {
    if command -v stdbuf >/dev/null 2>&1; then
        exec stdbuf -oL tcpdump "${TCPDUMP_ARGS[@]}" 2>&1
    fi

    exec tcpdump "${TCPDUMP_ARGS[@]}" 2>&1
}

run_tcpdump
