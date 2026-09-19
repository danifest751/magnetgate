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

// SetCountry records which country the user wants their traffic to leave through; empty means any.
//
// Nothing is rebuilt: the nodes are discovered and their planes wired already, so this only changes
// which of them the next stream prefers. It is a preference and not a restriction - when the chosen
// country has nothing live, traffic leaves through whatever is there, the same rule the desktop applies.
func SetCountry(country string) { mobile.SetCountry(country) }

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
	// FindConnectionOwner answers which app owns one connection, as JSON:
	// {"userId":..,"userName":..,"processPath":..,"androidPackageNames":[..]}. An error means "unknown",
	// which is what the engine expects when the lookup is not available.
	FindConnectionOwner(protocol int, sourceAddress string, sourcePort int, destinationAddress string, destinationPort int) (string, error)
	// Interfaces lists what this device has, as JSON:
	// [{"index":..,"mtu":..,"name":"..","flags":..,"addresses":["10.0.0.2/24",..]}]
	//
	// It comes from the app because Go cannot get it here: enumerating interfaces goes through a netlink
	// dump, and Android refuses that to an application (`netlinkrib: permission denied`). Without this the
	// engine hears that the network changed and then cannot resolve the interface it was told about -
	// which is the state this binding was in until 18.09, reporting `no such network interface` on every
	// switch.
	Interfaces() (string, error)
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

// FindConnectionOwner asks the app who owns a connection and hands the answer to the engine, which needs it
// for per-app rules and for its connection list.
func (p *platform) FindConnectionOwner(ipProtocol int32, sourceAddress string, sourcePort int32, destinationAddress string, destinationPort int32) (*libbox.ConnectionOwner, error) {
	encoded, err := p.handler.FindConnectionOwner(int(ipProtocol), sourceAddress, int(sourcePort), destinationAddress, int(destinationPort))
	if err != nil {
		return nil, err
	}
	var answer struct {
		UserID   int32    `json:"userId"`
		UserName string   `json:"userName"`
		Path     string   `json:"processPath"`
		Packages []string `json:"androidPackageNames"`
	}
	if err := json.Unmarshal([]byte(encoded), &answer); err != nil {
		return nil, err
	}
	owner := &libbox.ConnectionOwner{
		UserId:      answer.UserID,
		UserName:    answer.UserName,
		ProcessPath: answer.Path,
	}
	if len(answer.Packages) > 0 {
		owner.SetAndroidPackageNames(&stringIterator{items: answer.Packages})
	}
	return owner, nil
}

// stringIterator is the iterator libbox expects for a list of names.
type stringIterator struct {
	items []string
	next  int
}

func (i *stringIterator) HasNext() bool { return i.next < len(i.items) }

func (i *stringIterator) Next() string {
	value := i.items[i.next]
	i.next++
	return value
}

func (i *stringIterator) Len() int32 { return int32(len(i.items)) }

func (p *platform) LookupUser(string) (*libbox.PlatformUser, error) {
	return nil, errors.New("mgbox: user lookup is not implemented")
}

// The default network under the tunnel, and whoever inside the engine wants to hear about it changing.
//
// Android switches the network under a running VPN whenever it feels like it - Wi-Fi goes to sleep, the
// radio re-registers, the phone is simply carried out of the flat - and it does so most often while
// nobody is looking. Until this was implemented the engine was never told: `StartDefaultInterfaceMonitor`
// accepted the listener and dropped it, `GetInterfaces` returned nothing, and `auto_detect_interface` was
// off, so sing-box's picture of the network was whatever it had been at startup. Measured on the owner's
// phone twice: every long-lived connection aborted in the same second (ages 15m, 15m, 3m, 59s - all from
// the Wi-Fi address), and from then on new dials answered `connect: network is unreachable` until the
// tunnel was restarted by hand. To the owner: "the phone lay there with Telegram, I picked it up and no
// site would open".
var (
	networkMu        sync.Mutex
	networkListener  libbox.InterfaceUpdateListener
	networkName      string
	networkIndex     int32 = -1
	networkExpensive bool
)

// UpdateDefaultInterface is how the app reports what Android's default network is now. An index of -1
// means there is none at the moment, which the engine has to hear as well: a tunnel over no network at
// all is a different thing from a tunnel over a network that has changed.
func UpdateDefaultInterface(name string, index int, expensive bool) {
	networkMu.Lock()
	networkName, networkIndex, networkExpensive = name, int32(index), expensive
	listener := networkListener
	networkMu.Unlock()
	if listener != nil {
		listener.UpdateDefaultInterface(name, int32(index), expensive, false)
	}
}

func (p *platform) StartDefaultInterfaceMonitor(listener libbox.InterfaceUpdateListener) error {
	networkMu.Lock()
	networkListener = listener
	name, index, expensive := networkName, networkIndex, networkExpensive
	networkMu.Unlock()
	// tell it where we are now rather than waiting for the next change, or the engine starts blind
	listener.UpdateDefaultInterface(name, index, expensive, false)
	return nil
}

func (p *platform) CloseDefaultInterfaceMonitor(libbox.InterfaceUpdateListener) error {
	networkMu.Lock()
	networkListener = nil
	networkMu.Unlock()
	return nil
}

// GetInterfaces lists what this device has, which is how the engine turns the index above into an
// interface it can bind to. Returning nothing here was the other half of the same defect: even a
// reported change could not be resolved.
func (p *platform) GetInterfaces() (libbox.NetworkInterfaceIterator, error) {
	raw, err := p.handler.Interfaces()
	if err != nil {
		return nil, err
	}
	var listed []struct {
		Index     int32    `json:"index"`
		MTU       int32    `json:"mtu"`
		Name      string   `json:"name"`
		Flags     int32    `json:"flags"`
		Addresses []string `json:"addresses"`
	}
	if err := json.Unmarshal([]byte(raw), &listed); err != nil {
		return nil, err
	}
	out := make([]*libbox.NetworkInterface, 0, len(listed))
	for _, item := range listed {
		out = append(out, &libbox.NetworkInterface{
			Index:     item.Index,
			MTU:       item.MTU,
			Name:      item.Name,
			Addresses: &stringIterator{items: item.Addresses},
			Flags:     item.Flags,
		})
	}
	return &interfaceIterator{items: out}, nil
}

type interfaceIterator struct {
	items []*libbox.NetworkInterface
	next  int
}

func (i *interfaceIterator) HasNext() bool { return i.next < len(i.items) }

func (i *interfaceIterator) Next() *libbox.NetworkInterface {
	value := i.items[i.next]
	i.next++
	return value
}

func (p *platform) StartNeighborMonitor(libbox.NeighborUpdateListener) error { return nil }
func (p *platform) CloseNeighborMonitor(libbox.NeighborUpdateListener) error { return nil }
func (p *platform) SendNotification(*libbox.Notification) error              { return nil }
func (p *platform) CancelNotification(string, int32) error                   { return nil }
func (p *platform) LookupSFTPServer() (string, error)                        { return "", nil }
func (p *platform) ReadSystemSSHHostKey() (string, error)                    { return "", nil }

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
