package peer

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"github.com/gorilla/websocket"
	"io"
	"net"
	"sync"
	"time"
)

const maxMessage = 16 * 1024

type message struct {
	Type       string      `json:"type"`
	ID         string      `json:"id,omitempty"`
	Challenge  string      `json:"challenge,omitempty"`
	Credential *Credential `json:"credential,omitempty"`
	Proof      string      `json:"proof,omitempty"`
	Ready      bool        `json:"ready,omitempty"`
	Epoch      string      `json:"epoch,omitempty"`
	Country    string      `json:"country,omitempty"`
	Observed   string      `json:"observed,omitempty"`
	Slots      int         `json:"slots,omitempty"`
	Revision   uint64      `json:"revision,omitempty"`
	Countries  []Country   `json:"countries,omitempty"`
	Nodes      []Node      `json:"nodes,omitempty"`
	Ticket     *Ticket     `json:"ticket,omitempty"`
	Role       string      `json:"role,omitempty"`
	Error      string      `json:"error,omitempty"`
}

// WSConn carries a standard TLS byte stream in bounded binary WebSocket
// frames. One reader/one writer; writes are serialized for TLS close alerts.
type wsConn struct {
	*websocket.Conn
	read    io.Reader
	writeMu sync.Mutex
}

func newWS(c *websocket.Conn) *wsConn { c.SetReadLimit(64 * 1024); return &wsConn{Conn: c} }
func (c *wsConn) Read(b []byte) (int, error) {
	for {
		if c.read == nil {
			t, r, err := c.NextReader()
			if err != nil {
				return 0, err
			}
			if t != websocket.BinaryMessage {
				return 0, errors.New("expected binary peer frame")
			}
			c.read = r
		}
		n, err := c.read.Read(b)
		if err == io.EOF {
			c.read = nil
			if n > 0 {
				return n, nil
			}
			continue
		}
		return n, err
	}
}
func (c *wsConn) Write(b []byte) (int, error) {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	total := 0
	for len(b) > 0 {
		n := len(b)
		if n > 32*1024 {
			n = 32 * 1024
		}
		if err := c.WriteMessage(websocket.BinaryMessage, b[:n]); err != nil {
			return total, err
		}
		total += n
		b = b[n:]
	}
	return total, nil
}
func (c *wsConn) LocalAddr() net.Addr  { return c.UnderlyingConn().LocalAddr() }
func (c *wsConn) RemoteAddr() net.Addr { return c.UnderlyingConn().RemoteAddr() }
func (c *wsConn) SetDeadline(t time.Time) error {
	if err := c.SetReadDeadline(t); err != nil {
		return err
	}
	return c.SetWriteDeadline(t)
}

func writeObject(w io.Writer, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if len(b) > maxMessage {
		return errors.New("peer message too large")
	}
	head := make([]byte, 4)
	binary.BigEndian.PutUint32(head, uint32(len(b)))
	if _, err = w.Write(head); err != nil {
		return err
	}
	_, err = w.Write(b)
	return err
}
func readObject(r io.Reader, v any) error {
	var head [4]byte
	if _, err := io.ReadFull(r, head[:]); err != nil {
		return err
	}
	n := binary.BigEndian.Uint32(head[:])
	if n == 0 || n > maxMessage {
		return errors.New("invalid peer message size")
	}
	b := make([]byte, n)
	if _, err := io.ReadFull(r, b); err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}
