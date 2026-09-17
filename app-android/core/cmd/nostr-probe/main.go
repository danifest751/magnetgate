// Command nostr-probe answers one question the channel itself cannot: does a relay actually hand us
// the offer we subscribed for. It repeats what core/nostr does — same author filter, same `d` tag,
// same signature check, same unseal — but reports every stage, so "subscribed" can be told apart from
// "connected", and "connected" from "served an event".
//
// It is built for the device as well: the phone's view of a relay is the only one that counts.
package main

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gorilla/websocket"

	"magnetgate/core/proto"
)

const kind = 30078

func main() {
	pskFile := flag.String("psk-file", "", "file holding the PSK (never pass it on the command line)")
	relays := flag.String("relays", "wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net", "comma-separated relay URLs")
	slotsFlag := flag.String("slots", "0,1", "comma-separated slots")
	wait := flag.Duration("wait", 12*time.Second, "how long to listen on each relay after subscribing")
	agents := flag.String("user-agents", "|Go-http-client/1.1|magnetgate/0.1.0|Mozilla/5.0", "'|'-separated User-Agent values to try; an empty one sends no header, which is what gorilla does by default")
	flag.Parse()

	psk, err := readPSK(*pskFile)
	if err != nil {
		fail(err)
	}
	slots, err := parseSlots(*slotsFlag)
	if err != nil {
		fail(err)
	}

	_, publicKeyHex, err := proto.NostrKeys(psk)
	if err != nil {
		fail(err)
	}
	fmt.Printf("author %s\n", publicKeyHex)

	tags := map[int]string{}
	boxKeys := map[int][32]byte{}
	for _, slot := range slots {
		tag, err := proto.NostrTagOf(psk, slot)
		if err != nil {
			fail(err)
		}
		key, err := proto.SlotBoxKey(psk, slot)
		if err != nil {
			fail(err)
		}
		tags[slot], boxKeys[slot] = tag, key
		fmt.Printf("slot %d: d=%s\n", slot, tag)
	}

	served := 0
	for _, url := range strings.Split(*relays, ",") {
		url = strings.TrimSpace(url)
		if url == "" {
			continue
		}
		fmt.Printf("\n### %s\n", url)
		for _, agent := range strings.Split(*agents, "|") {
			if probe(url, agent, publicKeyHex, slots, tags, boxKeys, *wait) {
				served++
			}
		}
	}

	fmt.Printf("\nrelays that served an offer: %d\n", served)
	if served == 0 {
		fmt.Println("VERDICT: no relay handed this client an offer")
		os.Exit(1)
	}
	fmt.Println("VERDICT: the nostr path delivers on this network")
}

// probe walks one relay through every stage and says which one it stopped at.
func probe(url, userAgent, publicKeyHex string, slots []int, tags map[int]string, boxKeys map[int][32]byte, wait time.Duration) bool {
	label := userAgent
	if label == "" {
		label = "<none, which is how core/nostr dials today>"
	}
	fmt.Printf("\n  -- User-Agent: %s\n", label)
	var header http.Header
	if userAgent != "" {
		header = http.Header{"User-Agent": []string{userAgent}}
	}
	started := time.Now()
	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second}
	conn, response, err := dialer.Dial(url, header)
	if err != nil {
		// the status is the whole story when an edge refuses the upgrade, and gorilla keeps it out of the error
		status := "no response"
		if response != nil {
			status = response.Status
		}
		fmt.Printf("  connect : FAILED after %s: %v (%s)\n", time.Since(started).Round(time.Millisecond), err, status)
		return false
	}
	defer conn.Close()
	fmt.Printf("  connect : ok in %s\n", time.Since(started).Round(time.Millisecond))

	for _, slot := range slots {
		filter := map[string]any{
			"authors": []string{publicKeyHex},
			"kinds":   []int{kind},
			"#d":      []string{tags[slot]},
			"limit":   1,
		}
		request, err := json.Marshal([]any{"REQ", fmt.Sprintf("mgt%d", slot), filter})
		if err != nil {
			fail(err)
		}
		if err := conn.WriteMessage(websocket.TextMessage, request); err != nil {
			fmt.Printf("  subscribe slot %d: FAILED: %v\n", slot, err)
			return false
		}
		fmt.Printf("  subscribe slot %d: sent\n", slot)
	}

	deadline := time.Now().Add(wait)
	conn.SetReadDeadline(deadline)
	events, eose := 0, 0
	for time.Now().Before(deadline) {
		_, data, err := conn.ReadMessage()
		if err != nil {
			if events == 0 && eose == 0 {
				fmt.Printf("  read    : %v\n", err)
			}
			break
		}
		var message []json.RawMessage
		if err := json.Unmarshal(data, &message); err != nil || len(message) < 2 {
			continue
		}
		var verb string
		json.Unmarshal(message[0], &verb)
		switch verb {
		case "EOSE":
			eose++
			fmt.Printf("  EOSE    : relay says it has sent everything it holds (%s)\n", trim(message[1]))
		case "NOTICE", "CLOSED":
			fmt.Printf("  %s  : %s\n", verb, trim(data))
		case "EVENT":
			if len(message) < 3 {
				continue
			}
			events++
			report(message[2], publicKeyHex, slots, tags, boxKeys)
		}
	}
	if events == 0 {
		if eose > 0 {
			fmt.Println("  RESULT  : connected and subscribed, relay holds NOTHING for this author")
		} else {
			fmt.Println("  RESULT  : connected, but the relay never answered the subscription")
		}
		return false
	}
	return true
}

// report puts one event through the same gates core/nostr applies, so a drop can be located.
func report(raw json.RawMessage, publicKeyHex string, slots []int, tags map[int]string, boxKeys map[int][32]byte) {
	var ev struct {
		ID        string     `json:"id"`
		PubKey    string     `json:"pubkey"`
		CreatedAt int64      `json:"created_at"`
		Kind      int        `json:"kind"`
		Tags      [][]string `json:"tags"`
		Content   string     `json:"content"`
		Sig       string     `json:"sig"`
	}
	if err := json.Unmarshal(raw, &ev); err != nil {
		fmt.Printf("  EVENT   : unparseable: %v\n", err)
		return
	}
	dTag, seq := "", ""
	for _, tag := range ev.Tags {
		if len(tag) >= 2 {
			switch tag[0] {
			case "d":
				dTag = tag[1]
			case "mgt-seq":
				seq = tag[1]
			}
		}
	}
	age := time.Since(time.Unix(ev.CreatedAt, 0)).Round(time.Second)
	slot := -1
	for _, s := range slots {
		if tags[s] == dTag {
			slot = s
		}
	}
	fmt.Printf("  EVENT   : kind=%d slot=%d seq=%q published %s ago\n", ev.Kind, slot, seq, age)
	if ev.PubKey != publicKeyHex {
		fmt.Printf("            author mismatch: %s\n", ev.PubKey)
		return
	}
	if slot < 0 {
		fmt.Printf("            d tag %q is none of ours\n", dTag)
		return
	}
	id, _ := hex.DecodeString(ev.ID)
	sig, _ := hex.DecodeString(ev.Sig)
	// the same bytes core/nostr signs over: compact JSON with HTML escaping off, as the Node encoder writes it
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	encoder.Encode([]any{0, ev.PubKey, ev.CreatedAt, ev.Kind, ev.Tags, ev.Content})
	signed := bytes.TrimRight(buf.Bytes(), "\n")
	if !proto.NostrVerify(ev.PubKey, id, sig, signed) {
		fmt.Println("            signature does NOT verify")
		return
	}
	sealed, err := base64.StdEncoding.DecodeString(ev.Content)
	if err != nil {
		fmt.Printf("            content is not base64: %v\n", err)
		return
	}
	key := boxKeys[slot]
	plain := proto.Unseal(&key, sealed, seq)
	if plain == nil {
		fmt.Printf("            envelope did NOT unseal at %q\n", seq)
		return
	}
	var parsed struct {
		Node string            `json:"node"`
		DP   []json.RawMessage `json:"dp"`
	}
	json.Unmarshal(plain, &parsed)
	planes := make([]string, 0, len(parsed.DP))
	for _, entry := range parsed.DP {
		// the offer names a plane in "t", the same key the snapshot carries
		var typed struct {
			Type string `json:"t"`
		}
		json.Unmarshal(entry, &typed)
		planes = append(planes, typed.Type)
	}
	fmt.Printf("            unsealed: node=%q planes=%v  <-- the core would have used this\n", parsed.Node, planes)
}

func trim(raw []byte) string {
	text := strings.TrimSpace(string(raw))
	if len(text) > 160 {
		return text[:160] + "…"
	}
	return text
}

func readPSK(path string) (string, error) {
	if path == "" {
		return "", fmt.Errorf("-psk-file is required")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	psk := strings.TrimSpace(string(data))
	if psk == "" {
		return "", fmt.Errorf("%s is empty", path)
	}
	return psk, nil
}

func parseSlots(text string) ([]int, error) {
	var slots []int
	for _, part := range strings.Split(text, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		var slot int
		if _, err := fmt.Sscanf(part, "%d", &slot); err != nil {
			return nil, fmt.Errorf("bad slot %q", part)
		}
		if err := proto.ValidSlot(slot); err != nil {
			return nil, err
		}
		slots = append(slots, slot)
	}
	if len(slots) == 0 {
		return nil, fmt.Errorf("no slots")
	}
	return slots, nil
}

func fail(err error) {
	fmt.Fprintf(os.Stderr, "nostr-probe: %v\n", err)
	os.Exit(2)
}
