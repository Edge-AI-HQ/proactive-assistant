# @pin/capacitor-ambient-ai

Unified Capacitor plugin package that exposes the device-side ambient
context surfaces (audio, location, sensors, health, calendar, etc.) used by
the Proactive AI runtime.

The package combines two implementation styles:

- **Native plugins** (`registerPlugin` + Swift `CAPPlugin`) for surfaces
  whose iOS native integration is non-trivial (sound classification, visit
  monitoring, calendar, BLE, etc.).
- **TS adapters** (plain TS classes that match the Capacitor plugin shape)
  that wrap stable community plugins (`@capgo/capacitor-barometer`,
  `@capgo/capacitor-health`, `@capacitor/device`,
  `@capacitor-community/contacts`). Adapters are zero-bridge — listeners
  dispatch entirely in JS — so they reduce native maintenance and inherit
  upstream Android support.

Consumers see one uniform API: every surface exposes
`startMonitoring / stopMonitoring / addListener / removeAllListeners` and
event payloads are stable across implementation styles.

## Module capability matrix

| Module | Implementation | iOS permission / capability | Foreground only | Cadence |
|---|---|---|---|---|
| `SoundClassifier` | native | `NSMicrophoneUsageDescription` | no (audio session) | event-driven |
| `VisitMonitor` | native | `NSLocationAlwaysAndWhenInUseUsageDescription` | no (CLVisit / CMMotionActivity) | event-driven |
| `DeviceState` | native | none | no | 5min poll + delta |
| `Calendar` | native | `NSCalendarsFullAccessUsageDescription` | no (GCD timer) | 15min |
| `NotificationUsage` | native | `NSUserNotificationUsageDescription` | no | event-driven |
| `MediaNotebook` | native | `NSPhotoLibraryUsageDescription` | mostly foreground | event-driven |
| `NearbyConnectivity` | native | `NSBluetoothAlwaysUsageDescription` | no | continuous BLE scan |
| `AudioAmbient` | native | `NSMicrophoneUsageDescription` | no (audio session) | continuous |
| `SensorFusion` | TS adapter (`@capgo/capacitor-barometer`) | none | **yes** | 5min + 0.2 kPa delta |
| `HealthConnect` | TS adapter (`@capgo/capacitor-health`) | HealthKit entitlement, per-type read | **yes** | 15min |
| `Battery` | TS adapter (`@capacitor/device`) | none | **yes** | 5min + 5% delta |
| `Contacts` | TS adapter (`@capacitor-community/contacts`) | `NSContactsUsageDescription` | **yes** | 24h |

### What "foreground only" means

TS adapters are driven by `setInterval` in the JavaScript runtime. iOS
suspends the JS runtime when the app is locked or backgrounded, so timers
do not tick and no events are emitted during that period. Native plugins
that use GCD `DispatchSourceTimer` or system event sources continue to
deliver while the app is alive.

The host runtime (e.g. `proactive-ai-frontend`'s ambient runtime) is
responsible for restarting monitoring on `resume` and tolerating gaps in
the foreground-only modules.

## Required Info.plist keys (host app)

Set these in the host app's `Info.plist` for any module the host enables:

| Module | Key | Notes |
|---|---|---|
| SoundClassifier / AudioAmbient | `NSMicrophoneUsageDescription` | shared across both audio surfaces |
| VisitMonitor | `NSLocationAlwaysAndWhenInUseUsageDescription` | required for CLVisit |
| Calendar | `NSCalendarsFullAccessUsageDescription` | iOS 17+ event store |
| MediaNotebook | `NSPhotoLibraryUsageDescription` | photos library scan |
| NotificationUsage | `NSUserNotificationUsageDescription` | local notification stats |
| NearbyConnectivity | `NSBluetoothAlwaysUsageDescription` | BLE scanning |
| Contacts (TS adapter) | `NSContactsUsageDescription` | CNContactStore via community plugin |
| HealthConnect (TS adapter) | `NSHealthShareUsageDescription` | reading HealthKit; also requires HealthKit capability |

## Required Xcode capabilities

Enable in the host app's **Signing & Capabilities** tab:

- **HealthKit** — required by `HealthConnect`.

## SPM / build environment notes

Two known cap-sync side-effects must be patched after every
`npx cap sync ios` (the `cap:sync` script in this package's host apps does
both automatically):

1. **`IPHONEOS_DEPLOYMENT_TARGET` rewriting** — cap sync sets the host
   project's deployment target to the minimum across all installed
   plugins. `@pin/capacitor-ambient-ai` requires iOS 17. Re-apply with
   `node ../ambient-ai/scripts/fix-deployment-target.mjs <pbxproj>`.
2. **`@capacitor-community/contacts@7.2.0` swift-pm version constraint** —
   the upstream package declares `capacitor-swift-pm: from "7.0.0"`,
   incompatible with Capacitor 8's `exact "8.3.1"`. Use
   `patch-package` (the host app's `patches/` directory contains the
   pinned diff bumping the constraint to `from "8.0.0"`).

## Privacy notes

- `Contacts` adapter intentionally emits **aggregated counts only**
  (`{ total, withEmail, withPhone }`); it never returns the raw contact
  list. The host runtime should treat this as a coarse signal, not a
  source of identifiers.
- `HealthConnect` aggregates over multi-hour windows (today's steps, last
  sleep session, 6h heart-rate average). Per-sample data stays inside
  HealthKit.

## Versioning

- Plugin minimum platform: **iOS 17**.
- Capacitor: **^8.0.0**.
- Community plugins are pinned via this package's `dependencies`; host
  apps install only `@pin/capacitor-ambient-ai`.
