// Package mgbox is the app's single entry point into the Go side: the rendezvous/SOCKS core and the
// sing-box engine (libbox) live in one binding, which means one Go runtime inside the app process.
//
// Two separate gomobile bindings cannot share a process - they are two Go runtimes, and the engine's
// callbacks into Java abort while unwinding a stack that holds frames from the other runtime
// ("unexpected return pc for runtime.cgocallback", then "fatal error: unknown caller pc"). One binding
// removes that, and it removes the workarounds two bindings needed as well: no duplicate support
// classes to strip, and no second library to load by hand.
//
// The engine asks the platform for a tun and for socket protection; those two are the only things the
// app implements (PlatformHandler). Everything else the engine may ask for is answered here with an
// explicit default, so the app does not have to carry twenty-seven no-op methods.
package mgbox

import (
	"encoding/json"
	"errors"
	"strconv"
	"sync"

	"github.com/sagernet/sing-box/experimental/libbox"

	"magnetgate/core/mobile"
)

// CoreVersion is the core build the app is running.
func CoreVersion() string { return mobile.Version }

// StartCore brings the core up (rendezvous, data plane, loopback SOCKS) and returns the SOCKS port the
// engine should send its outbound traffic to.
func StartCore(configJSON string) (int, error) { return mobile.Start(configJSON) }

// CoreStatus is the diagnostics document the app renders.
func CoreStatus() (string, error) { return mobile.Status() }

// StopCore tears the core down.
func StopCore() { mobile.Stop() }

// SetPlaneSocksPort tells the core where the engine exposes one node's plane.
//
// The engine speaks transports the core does not implement (reality, hysteria2) and can serve each node's
// plane on a loopback SOCKS listener; the core then uses that plane like any other. The app calls this once
// the engine's configuration is in place, for every plane it put in there.
func SetPlaneSocksPort(slot int, plane string, port int) error {
	return mobile.SetPlaneSocksPort(slot, plane, port)
}

// ForgetPlaneSocksPorts drops every mapping, for when the engine is rebuilt.
func ForgetPlaneSocksPorts() { mobile.ForgetPlaneSocksPorts() }

// SetupEngine prepares the engine's data directories. It must be called before StartEngine.
//
// The paths are separate arguments rather than a struct because gomobile binds neither a struct value nor
// a struct parameter in an exported signature.
func SetupEngine(basePath, workingPath, tempPath string, logMaxLines int, debug bool) error {
	return libbox.Setup(&libbox.SetupOptions{
		BasePath:    basePath,
		WorkingPath: workingPath,
		TempPath:    tempPath,
		LogMaxLines: logMaxLines,
		Debug:       debug,
	})
}

// tunRequest is what the engine asks for when it wants a tunnel, flattened so the app does not have to
// implement libbox's own option types. Addresses are "address/prefix".
//
// It crosses the binding as JSON: gomobile cannot pass a struct as an interface method parameter, and
// the app parses it with the same JSON reader it uses everywhere else.
type tunRequest struct {
	MTU               int32
	Inet4Address      []string
	Inet6Address      []string
	Inet4RouteAddress []string
	Inet6RouteAddress []string
	DNSServerAddress  []string
	IncludePackage    []string
	ExcludePackage    []string
	AutoRoute         bool
	StrictRoute       bool
}

// PlatformHandler is what the app implements.
type PlatformHandler interface {
	// OpenTun is asked for a tunnel; the request is the JSON form of tunRequest.
	OpenTun(requestJSON string) (int32, error)
	// Protect is how the engine keeps one of its own sockets out of the tunnel it just created.
	Protect(fd int32) error
}

var (
	engineMu sync.Mutex
	engine   *libbox.CommandServer
)

// StartEngine runs the engine with the given configuration and platform handler.
func StartEngine(configJSON string, handler PlatformHandler) error {
	engineMu.Lock()
	defer engineMu.Unlock()
	if engine != nil {
		return errors.New("mgbox: the engine is already running")
	}
	server, err := libbox.NewCommandServer(commandHandler{}, &platform{handler: handler})
	if err != nil {
		return err
	}
	if err := server.Start(); err != nil {
		return err
	}
	// an empty options value, not nil: StartOrReloadService dereferences it
	if err := server.StartOrReloadService(configJSON, &libbox.OverrideOptions{}); err != nil {
		server.Close()
		return err
	}
	engine = server
	return nil
}

// ReloadEngine applies a new configuration to a running engine.
//
// The engine rebuilds itself, which means its tun is re-established through the platform; the app's own
// sockets and the core keep running, so only the connections inside the tunnel are interrupted. That is the
// price of following a changing set of nodes, and it is the same trade the desktop client makes.
func ReloadEngine(configJSON string) error {
	engineMu.Lock()
	server := engine
	engineMu.Unlock()
	if server == nil {
		return errors.New("mgbox: the engine is not running")
	}
	return server.StartOrReloadService(configJSON, &libbox.OverrideOptions{})
}

// StopEngine takes the engine (and its tunnel) down.
func StopEngine() {
	engineMu.Lock()
	server := engine
	engine = nil
	engineMu.Unlock()
	if server == nil {
		return
	}
	_ = server.CloseService()
	server.Close()
}

// commandHandler completes libbox's own handler interface. Nothing in it is needed here: the service owns
// the tunnel, and the remaining callbacks belong to features this client does not offer.
type commandHandler struct{}

func (commandHandler) ServiceStop() error                                       { return nil }
func (commandHandler) ServiceReload() error                                     { return nil }
func (commandHandler) GetSystemProxyStatus() (*libbox.SystemProxyStatus, error) { return nil, nil }
func (commandHandler) SetSystemProxyEnabled(bool) error                         { return nil }
func (commandHandler) TriggerNativeCrash() error                                { return nil }
func (commandHandler) WriteDebugMessage(string)                                 {}
func (commandHandler) ConnectSSHAgent() (int32, error) {
	return -1, errors.New("mgbox: ssh agent is not used")
}

// platform adapts the engine's platform interface to the two things the app implements.
type platform struct {
	handler PlatformHandler
}

func (p *platform) OpenTun(options libbox.TunOptions) (int32, error) {
	request := tunRequest{
		MTU:               options.GetMTU(),
		AutoRoute:         options.GetAutoRoute(),
		StrictRoute:       options.GetStrictRoute(),
		Inet4Address:      prefixStrings(options.GetInet4Address()),
		Inet6Address:      prefixStrings(options.GetInet6Address()),
		Inet4RouteAddress: prefixStrings(options.GetInet4RouteAddress()),
		Inet6RouteAddress: prefixStrings(options.GetInet6RouteAddress()),
		IncludePackage:    stringSlice(options.GetIncludePackage()),
		ExcludePackage:    stringSlice(options.GetExcludePackage()),
	}
	if dns, err := options.GetDNSServerAddress(); err == nil {
		request.DNSServerAddress = stringSlice(dns)
	}
	encoded, err := json.Marshal(request)
	if err != nil {
		return 0, err
	}
	return p.handler.OpenTun(string(encoded))
}

// AutoDetectInterfaceControl is how the engine asks for a socket to be kept out of its own tunnel.
func (p *platform) AutoDetectInterfaceControl(fd int32) error { return p.handler.Protect(fd) }

func (p *platform) UsePlatformAutoDetectInterfaceControl() bool { return true }
func (p *platform) LocalDNSTransport() libbox.LocalDNSTransport { return nil }
func (p *platform) UseProcFS() bool                             { return false }
func (p *platform) UnderNetworkExtension() bool                 { return false }
func (p *platform) IncludeAllNetworks() bool                    { return false }
func (p *platform) ReadWIFIState() *libbox.WIFIState            { return nil }
func (p *platform) ClearDNSCache()                              {}
func (p *platform) RegisterMyInterface(string)                  {}
func (p *platform) UsePlatformShell() bool                      { return false }
func (p *platform) UsePlatformBridge() bool                     { return false }
func (p *platform) TailscaleHostname() string                   { return "" }

// FindConnectionOwner and LookupUser are two methods libbox dereferences when they return no error, so an
// unimplemented lookup has to say it failed instead of answering "unknown". Per-app routing, which is what
// the connection owner is for, needs ConnectivityManager.getConnectionOwnerUid and is not wired up yet.
func (p *platform) FindConnectionOwner(int32, string, int32, string, int32) (*libbox.ConnectionOwner, error) {
	return nil, errors.New("mgbox: connection owner lookup is not implemented")
}

func (p *platform) LookupUser(string) (*libbox.PlatformUser, error) {
	return nil, errors.New("mgbox: user lookup is not implemented")
}

func (p *platform) GetInterfaces() (libbox.NetworkInterfaceIterator, error)           { return nil, nil }
func (p *platform) StartDefaultInterfaceMonitor(libbox.InterfaceUpdateListener) error { return nil }
func (p *platform) CloseDefaultInterfaceMonitor(libbox.InterfaceUpdateListener) error { return nil }
func (p *platform) StartNeighborMonitor(libbox.NeighborUpdateListener) error          { return nil }
func (p *platform) CloseNeighborMonitor(libbox.NeighborUpdateListener) error          { return nil }
func (p *platform) SendNotification(*libbox.Notification) error                       { return nil }
func (p *platform) CancelNotification(string, int32) error                            { return nil }
func (p *platform) LookupSFTPServer() (string, error)                                 { return "", nil }
func (p *platform) ReadSystemSSHHostKey() (string, error)                             { return "", nil }

func (p *platform) CheckPlatformShell() error {
	return errors.New("mgbox: shell sessions are not used")
}

func (p *platform) OpenShellSession(*libbox.PlatformUser, string, libbox.StringIterator, string, int32, int32) (libbox.ShellSession, error) {
	return nil, errors.New("mgbox: shell sessions are not used")
}

func (p *platform) CreateBridge(*libbox.BridgeOptions) (libbox.BridgeSession, error) {
	return nil, errors.New("mgbox: bridges are not used")
}

func prefixStrings(iterator libbox.RoutePrefixIterator) []string {
	if iterator == nil {
		return nil
	}
	var out []string
	for iterator.HasNext() {
		prefix := iterator.Next()
		out = append(out, prefix.Address()+"/"+strconv.FormatInt(int64(prefix.Prefix()), 10))
	}
	return out
}

func stringSlice(iterator libbox.StringIterator) []string {
	if iterator == nil {
		return nil
	}
	var out []string
	for iterator.HasNext() {
		out = append(out, iterator.Next())
	}
	return out
}
