// hs drives one step of the protocol handshake so the other implementation can be on the far side.
// Used by scripts/dev/verify-vectors.mjs; the PSK comes from the environment, never from argv.
//
//	MG_PSK=... go run ./cmd/hs -mode=init                       → {"msg1":..,"ceSk":..,"cePk":..}
//	MG_PSK=... go run ./cmd/hs -mode=respond < msg1.hex          → {"msg2":..,"c2e":..,"e2c":..,"cePk":..}
//	MG_PSK=... MG_CE_SK=.. MG_CE_PK=.. go run ./cmd/hs -mode=finish < msg2.hex
//	                                                            → {"c2e":..,"e2c":..}
//
// Exit codes: 0 ok, 1 the handshake step was rejected, 2 bad usage.
package main

import (
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"magnetgate/core/proto"
)

func fail(err error) {
	fmt.Fprintf(os.Stderr, "%v\n", err)
	os.Exit(1)
}

func main() {
	mode := flag.String("mode", "", "init, respond or finish")
	flag.Parse()
	psk := os.Getenv("MG_PSK")
	if psk == "" || (*mode != "init" && *mode != "respond" && *mode != "finish") {
		fmt.Fprintln(os.Stderr, "usage: MG_PSK=... hs -mode=init|respond|finish")
		os.Exit(2)
	}
	keys, err := proto.DeriveKeys(psk)
	if err != nil {
		fmt.Fprintf(os.Stderr, "derive: %v\n", err)
		os.Exit(2)
	}
	enc := json.NewEncoder(os.Stdout)

	readHex := func() []byte {
		raw, err := io.ReadAll(os.Stdin)
		if err != nil {
			fmt.Fprintf(os.Stderr, "stdin: %v\n", err)
			os.Exit(2)
		}
		out, err := hex.DecodeString(strings.TrimSpace(string(raw)))
		if err != nil {
			fmt.Fprintf(os.Stderr, "hex: %v\n", err)
			os.Exit(2)
		}
		return out
	}

	switch *mode {
	case "init":
		msg1, eph, err := proto.ClientInit(&keys.BoxKey, time.Now())
		if err != nil {
			fail(err)
		}
		enc.Encode(map[string]string{
			"msg1": hex.EncodeToString(msg1),
			"ceSk": hex.EncodeToString(eph.Sk[:]),
			"cePk": hex.EncodeToString(eph.Pk[:]),
		})
	case "respond":
		msg1 := readHex()
		msg2, session, cePk, err := proto.ExitRespond(&keys.BoxKey, msg1, time.Now())
		if err != nil {
			fail(err)
		}
		enc.Encode(map[string]string{
			"msg2": hex.EncodeToString(msg2),
			"c2e":  hex.EncodeToString(session.C2E[:]),
			"e2c":  hex.EncodeToString(session.E2C[:]),
			"cePk": hex.EncodeToString(cePk[:]),
		})
	case "finish":
		var eph proto.Ephemeral
		sk, err1 := hex.DecodeString(os.Getenv("MG_CE_SK"))
		pk, err2 := hex.DecodeString(os.Getenv("MG_CE_PK"))
		if err1 != nil || err2 != nil || len(sk) != 32 || len(pk) != 32 {
			fmt.Fprintln(os.Stderr, "MG_CE_SK and MG_CE_PK must be 32-byte hex")
			os.Exit(2)
		}
		copy(eph.Sk[:], sk)
		copy(eph.Pk[:], pk)
		session, err := proto.ClientFinish(&keys.BoxKey, readHex(), eph)
		if err != nil {
			fail(err)
		}
		enc.Encode(map[string]string{
			"c2e": hex.EncodeToString(session.C2E[:]),
			"e2c": hex.EncodeToString(session.E2C[:]),
		})
	}
}
