// frame encodes or decodes a single protocol frame, so scripts/dev/verify-vectors.mjs can prove that
// what one implementation writes the other reads.
//
//	MG_PSK=<psk> go run ./cmd/frame -mode=encode -type=2 -id=1 -seq=0 < payload   # prints hex
//	MG_PSK=<psk> go run ./cmd/frame -mode=decode < frame.hex                     # prints "type id plainHex"
//
// Exit codes: 0 ok, 1 the frame was rejected (killed), 2 bad usage.
package main

import (
	"encoding/binary"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"magnetgate/core/proto"
)

func main() {
	mode := flag.String("mode", "", "encode or decode")
	typ := flag.Int("type", 0, "frame type (encode)")
	streamID := flag.Uint("id", 0, "stream id (encode)")
	seq := flag.Uint64("seq", 0, "sequence number (encode)")
	flag.Parse()

	psk := os.Getenv("MG_PSK")
	if psk == "" || (*mode != "encode" && *mode != "decode") {
		fmt.Fprintln(os.Stderr, "usage: MG_PSK=... frame -mode=encode|decode [-type= -id= -seq=]")
		os.Exit(2)
	}
	keys, err := proto.DeriveKeys(psk)
	if err != nil {
		fmt.Fprintf(os.Stderr, "derive: %v\n", err)
		os.Exit(2)
	}
	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintf(os.Stderr, "stdin: %v\n", err)
		os.Exit(2)
	}

	switch *mode {
	case "encode":
		frame, err := proto.EncodeFrame(&keys.BoxKey, byte(*typ), uint32(*streamID), raw, *seq)
		if err != nil {
			fmt.Fprintf(os.Stderr, "encode: %v\n", err)
			os.Exit(1)
		}
		fmt.Println(hex.EncodeToString(frame))
	case "decode":
		wire, err := hex.DecodeString(strings.TrimSpace(string(raw)))
		if err != nil {
			fmt.Fprintf(os.Stderr, "hex: %v\n", err)
			os.Exit(2)
		}
		var got []proto.Frame
		killed := false
		dec := proto.NewDecoder(&keys.BoxKey, func(f proto.Frame) { got = append(got, f) }, func() { killed = true })
		dec.Push(wire)
		if killed || len(got) != 1 {
			fmt.Fprintf(os.Stderr, "rejected (frames=%d killed=%v)\n", len(got), killed)
			os.Exit(1)
		}
		out := make([]byte, 4)
		binary.BigEndian.PutUint32(out, got[0].StreamID)
		fmt.Printf("%d %d %s\n", got[0].Type, got[0].StreamID, hex.EncodeToString(got[0].Plain))
	}
}
