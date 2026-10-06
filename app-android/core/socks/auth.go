package socks

import (
	"bufio"
	"bytes"
	"crypto/subtle"
	"errors"
	"io"
)

func negotiateAuthenticated(w io.Writer, r *bufio.Reader, username, password string) error {
	var head [2]byte
	if _, e := io.ReadFull(r, head[:]); e != nil {
		return e
	}
	if head[0] != Version || head[1] == 0 {
		return errors.New("invalid greeting")
	}
	methods := make([]byte, int(head[1]))
	if _, e := io.ReadFull(r, methods); e != nil {
		return e
	}
	if !bytes.Contains(methods, []byte{2}) {
		_, _ = w.Write([]byte{Version, 255})
		return errors.New("authentication required")
	}
	if _, e := w.Write([]byte{Version, 2}); e != nil {
		return e
	}
	if _, e := io.ReadFull(r, head[:]); e != nil {
		return e
	}
	if head[0] != 1 || head[1] == 0 {
		return errors.New("invalid authentication")
	}
	u := make([]byte, int(head[1]))
	if _, e := io.ReadFull(r, u); e != nil {
		return e
	}
	n, e := r.ReadByte()
	if e != nil || n == 0 {
		return errors.New("invalid password")
	}
	p := make([]byte, int(n))
	if _, e = io.ReadFull(r, p); e != nil {
		return e
	}
	if subtle.ConstantTimeCompare(u, []byte(username)) != 1 || subtle.ConstantTimeCompare(p, []byte(password)) != 1 {
		_, _ = w.Write([]byte{1, 1})
		return errors.New("incorrect credentials")
	}
	_, e = w.Write([]byte{1, 0})
	return e
}
