//go:build !darwin

package main

import (
	"context"
	"net"
	"time"
)

func dialPhysical(ctx context.Context, address, _ string) (net.Conn, error) {
	return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "tcp", address)
}
