package socks

import (
	"context"
	"io"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestAuthenticatedListenerRejectsNoAuthAndWrongPasswordBeforeDial(t *testing.T) {
	var dials atomic.Int32
	server, err := ListenAuthenticated(0, "guest", strings.Repeat("secret", 4), func(context.Context, string, int) (Conn, error) { dials.Add(1); return nil, net.ErrClosed })
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	connect := func() net.Conn {
		c, e := net.Dial("tcp", server.Addr().String())
		if e != nil {
			t.Fatal(e)
		}
		c.SetDeadline(time.Now().Add(time.Second))
		t.Cleanup(func() { c.Close() })
		return c
	}
	c := connect()
	c.Write([]byte{5, 1, 0})
	var answer [2]byte
	io.ReadFull(c, answer[:])
	if answer != [2]byte{5, 255} {
		t.Fatal(answer)
	}
	c = connect()
	c.Write([]byte{5, 1, 2})
	io.ReadFull(c, answer[:])
	if answer != [2]byte{5, 2} {
		t.Fatal(answer)
	}
	c.Write(append(append([]byte{1, 5}, []byte("guest")...), append([]byte{5}, []byte("wrong")...)...))
	io.ReadFull(c, answer[:])
	if answer != [2]byte{1, 1} {
		t.Fatal(answer)
	}
	if dials.Load() != 0 {
		t.Fatal("unauthorized client reached target dial")
	}
	c = connect()
	c.Write([]byte{5, 1, 2})
	io.ReadFull(c, answer[:])
	password := strings.Repeat("secret", 4)
	c.Write(append(append([]byte{1, 5}, []byte("guest")...), append([]byte{byte(len(password))}, []byte(password)...)...))
	io.ReadFull(c, answer[:])
	if answer != [2]byte{1, 0} {
		t.Fatal(answer)
	}
}
