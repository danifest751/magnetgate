// seal reads plaintext on stdin and writes the sealed envelope as hex, so the Node implementation can
// open it. Used by scripts/dev/verify-vectors.mjs for the cross-implementation check; the PSK comes
// from the environment, never from argv (the same discipline as the exit nodes).
//
//	MG_PSK=<psk> MG_SLOT=0 MG_DOMAIN=42 go run ./cmd/seal < plaintext.txt
package main

import (
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"strconv"

	"magnetgate/core/proto"
)

func main() {
	psk := os.Getenv("MG_PSK")
	if psk == "" {
		fmt.Fprintln(os.Stderr, "MG_PSK is required")
		os.Exit(2)
	}
	slot := 0
	if raw := os.Getenv("MG_SLOT"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			fmt.Fprintf(os.Stderr, "MG_SLOT: %v\n", err)
			os.Exit(2)
		}
		slot = parsed
	}
	plain, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintf(os.Stderr, "stdin: %v\n", err)
		os.Exit(2)
	}
	key, err := proto.SlotBoxKey(psk, slot)
	if err != nil {
		fmt.Fprintf(os.Stderr, "slot key: %v\n", err)
		os.Exit(2)
	}
	envelope, err := proto.Seal(&key, plain, os.Getenv("MG_DOMAIN"))
	if err != nil {
		fmt.Fprintf(os.Stderr, "seal: %v\n", err)
		os.Exit(1)
	}
	fmt.Println(hex.EncodeToString(envelope))
}
