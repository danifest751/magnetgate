package nostr

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// relay is one WebSocket connection to a relay, kept alive: it reconnects with a growing backoff and
// re-sends every subscription it holds, because a relay forgets them as soon as the socket drops.
type relay struct {
	url     string
	cfg     Config
	logf    func(string, ...any)
	onEvent func(subID string, ev event)

	// connected is signalled once per successful connection, so a caller can tell "no offer" from
	// "not subscribed yet".
	connected chan struct{}

	mu      sync.Mutex
	conn    *websocket.Conn
	subs    map[string]string
	closed  bool
	done    chan struct{}
	writeMu sync.Mutex
}

func (r *relay) run() {
	backoff := r.cfg.Backoff
	for {
		if r.isClosed() {
			return
		}
		conn, err := r.dial()
		if err != nil {
			if !r.isClosed() {
				r.logf("nostr: %s: %v", r.url, err)
			}
		} else {
			// a connection that worked resets the backoff, so a relay that flaps once is not punished
			backoff = r.cfg.Backoff
			if err := r.serve(conn); err != nil && !r.isClosed() {
				r.logf("nostr: %s: %v", r.url, err)
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

func (r *relay) dial() (*websocket.Conn, error) {
	dialer := websocket.Dialer{HandshakeTimeout: r.cfg.DialTimeout, Proxy: http.ProxyFromEnvironment}
	conn, _, err := dialer.Dial(r.url, nil)
	if err != nil {
		return nil, err
	}
	return conn, nil
}

// serve owns the socket: it publishes the current subscriptions, tells the channel it is up and then
// reads until the connection dies.
func (r *relay) serve(conn *websocket.Conn) error {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		conn.Close()
		return nil
	}
	r.conn = conn
	requests := make([]string, 0, len(r.subs))
	for _, request := range r.subs {
		if request != "" {
			requests = append(requests, request)
		}
	}
	r.mu.Unlock()

	defer func() {
		r.mu.Lock()
		if r.conn == conn {
			r.conn = nil
		}
		r.mu.Unlock()
		conn.Close()
	}()

	for _, request := range requests {
		if err := r.write(conn, request); err != nil {
			return err
		}
	}
	select {
	case r.connected <- struct{}{}:
	default:
	}

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				return err
			}
			return nil
		}
		r.handle(data)
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

// subscribe remembers a subscription and sends it if the socket is up; a reconnect sends it again.
func (r *relay) subscribe(id, request string) {
	if request == "" {
		return
	}
	r.mu.Lock()
	r.subs[id] = request
	conn := r.conn
	r.mu.Unlock()
	if conn != nil {
		r.write(conn, request)
	}
}

// write serialises writers: a subscription can be added while the read loop is already running.
func (r *relay) write(conn *websocket.Conn, message string) error {
	r.writeMu.Lock()
	defer r.writeMu.Unlock()
	return conn.WriteMessage(websocket.TextMessage, []byte(message))
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
