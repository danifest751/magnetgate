package nostr

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// relay is one WebSocket connection to a relay, kept alive: it reconnects with a growing backoff and
// re-sends every subscription it holds, because a relay forgets them as soon as the socket drops.
//
// A relay counts as working only once it has answered something. On a mobile network the socket can
// open, carry the subscription out and then never deliver a byte back: the handshake is let through and
// the stream is not. That state is indistinguishable from "subscribed, nothing published yet" unless
// the connection is required to speak, which is what ReplyTimeout and the keepalive below are for.
type relay struct {
	url     string
	cfg     Config
	logf    func(string, ...any)
	onEvent func(subID string, ev event)

	// serving is the channel's shared signal, raised by whichever relay answers first, so a caller can
	// tell "nothing was published" from "nothing got through to us".
	serving chan struct{}

	mu       sync.Mutex
	conn     *websocket.Conn
	subs     map[string]string
	answered bool
	lastErr  string
	closed   bool
	done     chan struct{}
	writeMu  sync.Mutex
}

func (r *relay) run() {
	backoff := r.cfg.Backoff
	for {
		if r.isClosed() {
			return
		}
		conn, response, err := r.dial()
		if err != nil {
			if !r.isClosed() {
				// the status is the whole story when an edge refuses the upgrade, and gorilla keeps it out
				// of the error: "bad handshake" on its own sent a previous session looking at the wrong half
				r.fail(fmt.Sprintf("%v%s", err, statusSuffix(response)))
			}
		} else {
			answered, err := r.serve(conn)
			if err != nil && !r.isClosed() {
				r.fail(err.Error())
			}
			if answered {
				// only a relay that actually spoke to us resets the backoff; one that accepts the socket and
				// then stays mute would otherwise be reconnected every second for as long as the app runs
				backoff = r.cfg.Backoff
			}
		}

		select {
		case <-r.done:
			return
		case <-time.After(backoff):
		}
		if doubled := backoff * 2; doubled < r.cfg.MaxBackoff {
			backoff = doubled
		} else {
			backoff = r.cfg.MaxBackoff
		}
	}
}

func (r *relay) dial() (*websocket.Conn, *http.Response, error) {
	dialer := websocket.Dialer{HandshakeTimeout: r.cfg.DialTimeout, Proxy: http.ProxyFromEnvironment}
	// gorilla sends no User-Agent at all, and an edge in front of a relay answers such an upgrade with
	// 503 often enough to matter: measured on the phone, three upgrades without one drew two refusals
	// and three with one drew none.
	header := http.Header{"User-Agent": []string{r.cfg.UserAgent}}
	return dialer.Dial(r.url, header)
}

// serve owns the socket: it publishes the current subscriptions, then reads until the connection dies
// or falls silent. It reports whether the relay answered at all, which is the only evidence that this
// relay is of any use on this network.
func (r *relay) serve(conn *websocket.Conn) (bool, error) {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		conn.Close()
		return false, nil
	}
	r.conn = conn
	r.answered = false
	requests := make([]string, 0, len(r.subs))
	for _, request := range r.subs {
		if request != "" {
			requests = append(requests, request)
		}
	}
	r.mu.Unlock()

	stop := make(chan struct{})
	defer func() {
		close(stop)
		r.mu.Lock()
		if r.conn == conn {
			r.conn = nil
		}
		r.mu.Unlock()
		conn.Close()
	}()

	for _, request := range requests {
		if err := r.write(conn, request); err != nil {
			return false, err
		}
	}
	// a subscription that is already out has to be answered; with none yet, only the keepalive applies
	r.armDeadline(conn, len(requests) > 0)
	go r.keepAlive(conn, stop)

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			if !r.hasAnswered() {
				return false, fmt.Errorf("connected, but answered no subscription within %s: %w", r.cfg.ReplyTimeout, err)
			}
			if websocket.IsUnexpectedCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				return true, err
			}
			return true, nil
		}
		r.noteAnswer()
		r.armDeadline(conn, false)
		r.handle(data)
	}
}

// noteAnswer records the first message of a connection: this relay is reachable in both directions.
func (r *relay) noteAnswer() {
	r.mu.Lock()
	first := !r.answered
	r.answered = true
	r.lastErr = ""
	r.mu.Unlock()
	if !first {
		return
	}
	r.logf("nostr: %s: answering", r.url)
	select {
	case r.serving <- struct{}{}:
	default:
	}
}

// armDeadline picks how long the socket may stay quiet: the short window while a subscription is
// unanswered, the keepalive window once the relay has spoken.
func (r *relay) armDeadline(conn *websocket.Conn, awaitingReply bool) {
	timeout := r.cfg.ReadTimeout
	if awaitingReply && !r.hasAnswered() {
		timeout = r.cfg.ReplyTimeout
	}
	conn.SetReadDeadline(time.Now().Add(timeout))
}

// keepAlive pings, so that a socket which dies quietly is noticed instead of counted as connected. A
// pong reopens the read window; no pong lets the deadline expire and the connection is rebuilt.
func (r *relay) keepAlive(conn *websocket.Conn, stop <-chan struct{}) {
	conn.SetPongHandler(func(string) error {
		// a pong is not an answer to a subscription: a relay that returns control frames and no events
		// would otherwise hold the reply deadline open for as long as the app runs
		if !r.hasAnswered() {
			return nil
		}
		return conn.SetReadDeadline(time.Now().Add(r.cfg.ReadTimeout))
	})
	ticker := time.NewTicker(r.cfg.PingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-r.done:
			return
		case <-ticker.C:
			r.writeMu.Lock()
			conn.SetWriteDeadline(time.Now().Add(r.cfg.DialTimeout))
			err := conn.WriteMessage(websocket.PingMessage, nil)
			r.writeMu.Unlock()
			if err != nil {
				return
			}
		}
	}
}

// fail records why this relay is unusable and says so once, so the log carries the reason and not just
// the silence. Repeats are kept out of a ring log that other traffic is already crowding.
func (r *relay) fail(reason string) {
	r.mu.Lock()
	repeat := r.lastErr == reason
	r.lastErr = reason
	r.answered = false
	r.mu.Unlock()
	if !repeat {
		r.logf("nostr: %s: %s", r.url, reason)
	}
}

// handle routes one relay message: only EVENTs are interesting, and only for a subscription we made.
func (r *relay) handle(data []byte) {
	var message []json.RawMessage
	if err := json.Unmarshal(data, &message); err != nil || len(message) < 3 {
		return
	}
	var kind string
	if err := json.Unmarshal(message[0], &kind); err != nil || kind != "EVENT" {
		return
	}
	var subID string
	if err := json.Unmarshal(message[1], &subID); err != nil {
		return
	}
	var ev event
	if err := json.Unmarshal(message[2], &ev); err != nil {
		return
	}
	r.onEvent(subID, ev)
}

// subscribe remembers a subscription and sends it if the socket is up; a reconnect sends it again. It
// reports whether it went out now, so the channel can say how many relays actually carry it.
func (r *relay) subscribe(id, request string) bool {
	if request == "" {
		return false
	}
	r.mu.Lock()
	r.subs[id] = request
	conn := r.conn
	r.mu.Unlock()
	if conn == nil {
		return false
	}
	if err := r.write(conn, request); err != nil {
		return false
	}
	r.armDeadline(conn, true)
	return true
}

// write serialises writers: a subscription can be added while the read loop is already running.
func (r *relay) write(conn *websocket.Conn, message string) error {
	r.writeMu.Lock()
	defer r.writeMu.Unlock()
	conn.SetWriteDeadline(time.Now().Add(r.cfg.DialTimeout))
	return conn.WriteMessage(websocket.TextMessage, []byte(message))
}

func (r *relay) hasAnswered() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.answered
}

// state is what this relay is doing right now, for the status the app shows.
func (r *relay) state() RelayState {
	r.mu.Lock()
	defer r.mu.Unlock()
	return RelayState{URL: r.url, Connected: r.conn != nil, Answering: r.answered, LastError: r.lastErr}
}

func (r *relay) isClosed() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.closed
}

func (r *relay) close() {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return
	}
	r.closed = true
	conn := r.conn
	r.mu.Unlock()
	close(r.done)
	if conn != nil {
		conn.Close()
	}
}

func statusSuffix(response *http.Response) string {
	if response == nil {
		return ""
	}
	return " (" + response.Status + ")"
}
