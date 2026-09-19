# MagnetGate for Android

**Русский:** [README.ru.md](README.ru.md) · [Project overview](../README.md)

The native Android client uses Jetpack Compose and `VpnService`. A single `mgcore.aar` contains
the Go rendezvous/tunnel core and the sing-box engine. The Android package version is **0.1.0**
(`versionCode 1`), independent of the Node and desktop versions.

## Compatibility and APKs

Android **8.0 or newer (API 26+)** is the minimum. The build produces two separate APKs:

| Device | Debug APK, relative to the repository root |
|---|---|
| ARM64 phone (`arm64-v8a`) | `app-android/app/build/outputs/apk/debug/app-arm64-v8a-debug.apk` |
| x86_64 emulator | `app-android/app/build/outputs/apk/debug/app-x86_64-debug.apk` |

Install only the APK matching the device. There is no universal APK and no 32-bit ARM build.
The minimum API is a build requirement, not evidence of testing on every Android version or
manufacturer. Development testing includes an emulator and a Xiaomi phone with Android 16 / ARM64;
broader device coverage remains on the [roadmap](../ROADMAP.md).

APKs and the AAR are local build outputs, ignored by Git. The source tree does not include an
installer. Build with the instructions below or obtain a compatible signed APK from your operator.

## First connection

1. Install the APK and open **MagnetGate**. Allow installation from your chosen source if Android asks.
2. Use **Add access**, or **Settings → Group access**, to enter the shared key supplied by your
   administrator. In discovery options, enter the administrator's bootstrap addresses, Nostr relays
   and slots (numbers `0..15`). At least one discovery channel is required.
3. Tap **Save access**, return to **Home**, then tap **Connect** and accept Android's VPN permission.
4. Wait for **Connection working**. If it does not appear, open **Checks & diagnostics**.

The shared key is stored in encrypted preferences backed by Android Keystore. Do not publish it
with screenshots, logs or configuration examples. A DHT-only setup can discover Reality/native
endpoints; hysteria2 certificate material comes through the Nostr offer.

## Screens, language and display

| Screen | Controls |
|---|---|
| **Home** | Connection status, connect/disconnect, preferred country, tunnel latency, received bytes and diagnostics |
| **Rules** | Website routing mode, domain lists and application selection |
| **Settings** | Group access and advanced discovery settings |

The **RU / EN** switch is visible in the top-right corner of the main screens. The selection is
saved and applies immediately without restarting the VPN or discarding rule drafts. On first run,
a Russian system locale selects Russian; other locales select English. Both languages are bundled
for offline use. Core logs and third-party application names retain their original text.

Light/dark appearance and text size follow Android settings. For larger text, adjust the system
font size; **125% is a device setting**, not a separate MagnetGate setting. The app icon and the
three-tab layout are shared by both languages.

## Routing and applying changes

Website and application rules work together: the application selector decides which apps enter
the VPN, then website rules decide where their traffic goes.

| Website mode | Behavior for apps included in the VPN |
|---|---|
| **All traffic** | Tunnel internet traffic except the website exclusions |
| **By rule lists** | Tunnel destinations in the bundled rule lists and your VPN website list; other destinations go direct |

Private network destinations go direct. Enter domain names without `https://` or page paths.
The app uses DNS-over-HTTPS with IPv4 answers; IPv6 is captured and rejected rather than routed
outside the tunnel. Split mode depends on the lists included in the build or obtained through
authenticated rule-list updates. Without those lists, only explicit rules provide that coverage.

For applications, **All except selected** sends selected apps directly; **Selected apps only**
includes the selected apps in the VPN. **An empty selection in “Selected apps only” currently
includes all apps** in the chosen website mode. The picker lists launchable apps other than
MagnetGate; it is not an inventory of every system package.

Tap **Save rules** to persist edits. If the VPN is already running, tap **Reconnect & apply** to
activate them. Until then, the current tunnel retains its previous rules. Saving access/discovery
changes also requires reconnection. This differs from the desktop client's autosave behavior.

The country selector is a preference for **new connections**. Existing connections retain their
route. If no discovered node matches, the client may use another country; this is not a strict
geographic restriction.

## Diagnostics and protection limits

A running VPN interface alone does not mean the internet works. The app's working state requires
a fresh successful DNS/HTTPS check through the engine's proxy path. Diagnostics separates tunnel
latency from full request time and shows the last check's IP, discovery relays, servers/transports,
connection counters and recent core events. The last check does not establish the exit IP or route
of every concurrent connection.

For Android's system-level blocking while the VPN is unavailable, configure **Always-on VPN** and
**Block connections without VPN** in Android VPN settings where supported. This can also block
traffic you intended to send directly. The app alone does not guarantee connectivity blocking after
its process exits. Background restrictions and restart behavior depend on the device firmware.

## Build on Windows

Prepare PowerShell 5.1+, Go **1.26.0** (as declared by the Go modules), JDK **17**, Android SDK
platform **35**, build tools, platform-tools and an Android NDK compatible with the pinned native
dependencies. Set `JAVA_HOME` and `ANDROID_SDK_ROOT` (or `ANDROID_HOME`); use `ANDROID_NDK_HOME`
to choose an NDK explicitly. Put Go on `PATH`, or set `MG_GO` to its executable. Network access is
needed for the initial dependency downloads. Gradle is provided by the wrapper.

Run from the repository root:

```powershell
# Fetch checksum-pinned public routing lists (also downloads the Windows sing-box binary).
powershell -ExecutionPolicy Bypass -File scripts/get-singbox.ps1

# Build both arm64 and x86_64 into the single combined binding.
powershell -ExecutionPolicy Bypass -File scripts/android/build-aar.ps1

# Build the APKs and run local Android checks.
.\app-android\gradlew.bat -p app-android :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

The native build verifies the sing-box source tag/commit and uses the gomobile revision pinned in
[scripts/pins.json](../scripts/pins.json). Rebuild the AAR after changing Go core/engine code or native
pins. Kotlin/resources-only changes need the Gradle step. Do not combine independently built Go
bindings: the app requires one runtime in `app-android/libs/mgcore.aar`.

Gradle packages `.srs` files present in `tools/sing-box`. Missing lists do not fail the build;
the build reports what it included. `tunnel-userlist.srs`, if used, is supplied separately by the
operator. A checksum mismatch during fetching needs review of the upstream change and pins.

With USB debugging enabled and the device authorized, install an ARM64 debug build using:

```powershell
$adb = Join-Path $env:ANDROID_SDK_ROOT 'platform-tools/adb.exe'
& $adb devices
& $adb -s '<device-serial>' install -r app-android/app/build/outputs/apk/debug/app-arm64-v8a-debug.apk
```

If you configured only `ANDROID_HOME`, use that variable in the first line. `install -r` retains
app data when the signing key matches. A debug/release or signing-key change may prevent an
in-place update; do not uninstall without preserving the access information you will need again.

## Validation

Local JVM tests cover the UI state model and language resources; lint and compilation catch
additional Android issues. To test the Go core separately:

```powershell
Push-Location app-android/core
go test ./...
Pop-Location
```

Device scripts run from the repository root and require ADB, a compatible build and a reachable
operator-controlled exit:

| Script | What it verifies / changes |
|---|---|
| [app-core-check.ps1](../scripts/android/app-core-check.ps1) | Builds and installs on the configured emulator; requires `-PskFile` and `-Bootstrap`. Exercises discovery and the core's SOCKS path, not the full VPN route |
| [device-check.ps1](../scripts/android/device-check.ps1) | Physical-device VPN acceptance: service ownership, health, transports, routes, disconnect and fail-closed behavior |
| [switch-check.ps1](../scripts/android/switch-check.ps1) | Requires an active VPN; toggles Wi-Fi, measures recovery and requests through the engine; leaves Wi-Fi enabled |

Read each script's parameters before running it. `device-check.ps1` restarts the app and deliberately
interrupts connectivity; `-NoDisconnect -NoFailClosed` skips those two later checks but not the
initial force-stop. Existing stored access can be used without providing `-PskFile`. Keep device
reports and captures private. Unit tests and a successful core probe do not replace these network
checks or a wider Android/OEM compatibility matrix.

## Release signing

For a signed release, supply `magnetgate-release.jks` and `magnetgate-release.pass` in the private
key directory, with keystore alias `magnetgate`. By default, this is `key/` beside the repository,
not inside it. Override it with `MAGNETGATE_KEY_DIR` or an absolute `-Pmagnetgate.keyDir=...` path.

```powershell
.\app-android\gradlew.bat -p app-android :app:assembleRelease
```

Without those files, the release APKs are **unsigned**. Keep the signing key and password private
and backed up: future updates must use the same signing identity. Inspect the build output in
`app-android/app/build/outputs/apk/release/`; do not assume a local build is a published release.

Lucide icon attribution is in [THIRD_PARTY_ICONS.txt](THIRD_PARTY_ICONS.txt).
