// unseal reads a hex envelope on stdin and writes the plaintext on stdout, or exits 1 when the
// envelope cannot be opened (wrong key, wrong slot, wrong domain, tampered). Used by
// scripts/dev/verify-vectors.mjs to prove the Go core reads what the Node client sealed.
//
//	MG_PSK=<psk> MG_SLOT=0 MG_DOMAIN=42 go run ./cmd/unseal < envelope.hex
package main

import (
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

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
	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintf(os.Stderr, "stdin: %v\n", err)
		os.Exit(2)
	}
	envelope, err := hex.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil {
		fmt.Fprintf(os.Stderr, "hex: %v\n", err)
		os.Exit(2)
	}
	key, err := proto.SlotBoxKey(psk, slot)
	if err != nil {
		fmt.Fprintf(os.Stderr, "slot key: %v\n", err)
		os.Exit(2)
	}
	plain := proto.Unseal(&key, envelope, os.Getenv("MG_DOMAIN"))
	if plain == nil {
		os.Exit(1)
	}
	os.Stdout.Write(plain)
}
