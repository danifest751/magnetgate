package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"magnetgate/core/peer"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/signal"
	"syscall"
	"time"
)

type location struct {
	Prefix  string `json:"prefix"`
	Country string `json:"country"`
	Expires int64  `json:"expires"`
}
type config struct {
	Listen      string         `json:"listen"`
	Certificate string         `json:"certificate"`
	PrivateKey  string         `json:"privateKey"`
	StateDir    string         `json:"stateDir"`
	Accounts    []peer.Account `json:"accounts"`
	Locations   []location     `json:"locations"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	file := flag.String("config", "", "private service configuration")
	flag.Parse()
	if *file == "" {
		return errors.New("--config is required")
	}
	b, err := os.ReadFile(*file)
	if err != nil {
		return err
	}
	var cfg config
	if err = json.Unmarshal(b, &cfg); err != nil {
		return err
	}
	if cfg.StateDir == "" || cfg.Listen == "" || cfg.Certificate == "" || cfg.PrivateKey == "" {
		return errors.New("service configuration is incomplete")
	}
	_, identity, err := peer.OpenStore(cfg.StateDir)
	if err != nil {
		return err
	}
	// The first pilot uses a host-managed, dated location table. Devices cannot
	// self-report their country. Unknown source IPs are authenticated guests only.
	var prefixes []netip.Prefix
	for _, l := range cfg.Locations {
		p, e := netip.ParsePrefix(l.Prefix)
		if e != nil || len(l.Country) != 2 || l.Expires <= time.Now().Unix() {
			return errors.New("invalid or expired trusted location table")
		}
		prefixes = append(prefixes, p)
	}
	country := func(ip net.IP) (string, error) {
		a, ok := netip.AddrFromSlice(ip)
		if !ok {
			return "", errors.New("unknown source")
		}
		a = a.Unmap()
		for i, p := range prefixes {
			if p.Contains(a) && cfg.Locations[i].Expires > time.Now().Unix() {
				return cfg.Locations[i].Country, nil
			}
		}
		return "", errors.New("location is not verified")
	}
	service := peer.NewService(identity.Key, country)
	defer service.Close()
	if err := service.LoadRevocations(cfg.StateDir); err != nil {
		return err
	}
	service.Budget, err = peer.OpenRelayBudget(cfg.StateDir)
	if err != nil {
		return err
	}
	enrollment, err := peer.NewEnrollment(identity.Key, cfg.Accounts, cfg.StateDir)
	if err != nil {
		return err
	}
	enrollment.Denied = service.Denied
	mux := http.NewServeMux()
	mux.Handle("/v1/enroll", enrollment)
	mux.Handle("/", service.Handler())
	server := &http.Server{Addr: cfg.Listen, Handler: mux, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 20 * time.Second, MaxHeaderBytes: 8192, TLSConfig: &tls.Config{MinVersion: tls.VersionTLS13}}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	go func() {
		<-ctx.Done()
		service.Close()
		stop, c := context.WithTimeout(context.Background(), 5*time.Second)
		defer c()
		server.Shutdown(stop)
	}()
	fmt.Println("peer service authority:", identity.Public())
	err = server.ListenAndServeTLS(cfg.Certificate, cfg.PrivateKey)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
