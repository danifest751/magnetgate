package socks5client

import (
	"context"
	"io"
	"net"
	"testing"
	"time"
)

func TestCancellationClosesSocketDuringSocksHandshake(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan struct{})
	peerClosed := make(chan struct{})
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		conn.SetDeadline(time.Now().Add(time.Second))
		greeting := make([]byte, 3)
		io.ReadFull(conn, greeting)
		close(accepted)
		io.Copy(io.Discard, conn)
		close(peerClosed)
	}()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := Dial(ctx, listener.Addr().String(), "target.test", 443); done <- err }()
	<-accepted
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancelled handshake succeeded")
		}
	case <-time.After(300 * time.Millisecond):
		t.Fatal("SOCKS handshake ignored cancellation")
	}
	select {
	case <-peerClosed:
	case <-time.After(300 * time.Millisecond):
		t.Fatal("cancelled socket leaked")
	}
}
