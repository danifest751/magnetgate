// peer-node is a user-level host. Its administration channel is inherited
// stdin/stdout; there is no network administration listener.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"magnetgate/core/peer"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

type request struct {
	ID        string      `json:"id"`
	Command   string      `json:"command"`
	Policy    peer.Policy `json:"policy"`
	Country   string      `json:"country"`
	Port      int         `json:"port"`
	Suspended bool        `json:"suspended"`
}
type response struct {
	ID       string              `json:"id,omitempty"`
	Type     string              `json:"type"`
	Status   *peer.HostStatus    `json:"status,omitempty"`
	Endpoint *peer.GuestEndpoint `json:"endpoint,omitempty"`
	Error    string              `json:"error,omitempty"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	profile := flag.String("profile", "", "private profile directory")
	child := flag.Bool("user-child", false, "internal privilege-drop child")
	headless := flag.Bool("headless", false, "run a provisioned user node until interrupted")
	flag.Parse()
	if *profile == "" {
		return errors.New("--profile is required")
	}
	if handled, err := dropPrivileges(*child); handled || err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	network := newPhysicalNetwork(ctx)
	defer network.close()
	host, err := peer.OpenHost(ctx, *profile, network)
	if err != nil {
		return err
	}
	defer func() { cancel(); host.Close() }()
	var output sync.Mutex
	emit := func(r response) { output.Lock(); defer output.Unlock(); _ = json.NewEncoder(os.Stdout).Encode(r) }
	status := host.Status()
	emit(response{Type: "status", Status: &status})
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s := host.Status()
				emit(response{Type: "status", Status: &s})
			}
		}
	}()
	if *headless {
		<-ctx.Done()
		return nil
	}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 64*1024)
	var requests sync.WaitGroup
	defer func() { cancel(); requests.Wait() }()
	capacity := make(chan struct{}, 16)
	go func() { <-ctx.Done(); os.Stdin.Close() }()
	for scanner.Scan() {
		var req request
		if json.Unmarshal(scanner.Bytes(), &req) != nil {
			return errors.New("invalid host command")
		}
		if req.Command == "stop" {
			cancel()
			requests.Wait()
			emit(response{ID: req.ID, Type: "reply"})
			return nil
		}
		select {
		case capacity <- struct{}{}:
		default:
			emit(response{ID: req.ID, Type: "reply", Error: "host request capacity"})
			continue
		}
		requests.Add(1)
		go func(req request) {
			defer requests.Done()
			defer func() { <-capacity }()
			r := response{ID: req.ID, Type: "reply"}
			var err error
			switch req.Command {
			case "policy":
				err = host.SetPolicy(req.Policy)
			case "connect":
				var endpoint peer.GuestEndpoint
				endpoint, err = host.Connect(req.Country, req.Port)
				if err == nil {
					r.Endpoint = &endpoint
				}
			case "disconnect":
				host.Disconnect()
			case "suspend":
				network.suspend(req.Suspended)
				if req.Suspended && host.Client != nil {
					host.Client.SuspendExit()
				}
			case "status":
			default:
				err = errors.New("unknown host command")
			}
			if err != nil {
				r.Error = err.Error()
			}
			s := host.Status()
			r.Status = &s
			emit(r)
		}(req)
	}
	return scanner.Err()
}
