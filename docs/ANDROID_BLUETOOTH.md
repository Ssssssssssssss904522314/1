# EKOOOL Bluetooth — Android architecture

## Goal
Direct, consent-based device-to-device messaging between nearby Android installs, without routing chat messages through the EKOOOL server.

## Components
- `android-app/`: native Android WebView shell for the existing EKOOOL web client.
- `BluetoothBridge`: JavaScript interface exposed to the trusted EKOOOL origin.
- `BluetoothController`: BLE scanning, advertising, GATT service, peer connections and message delivery.
- Existing `index.html`: settings entry and Bluetooth screen.
- Existing Node server: keeps account/profile data; Bluetooth message bodies are not relayed through it.

## Transport
BLE discovery advertises a fixed EKOOOL service UUID. A GATT characteristic accepts UTF-8 message payloads and uses notifications for delivery. Keep initial messages under 512 bytes. BLE is range-limited; Android may restrict background discovery, so first release keeps the screen/session active.

## Trust and privacy
- Bluetooth is off by default and requires explicit user action.
- A discovered device is not a trusted identity. MAC addresses can change and must not be used as account identity.
- Before production, add a two-sided connection-acceptance UX, short verification code, authenticated key agreement (e.g. X25519), AEAD encryption, replay protection, and encrypted local history. GATT alone is not end-to-end encryption.
- Do not silently upload Bluetooth messages to the server.
- Android 12+ runtime permissions: BLUETOOTH_SCAN, BLUETOOTH_CONNECT, BLUETOOTH_ADVERTISE. Older versions may require location permission for scanning.

## Web bridge
`window.EKOOLBluetooth`: `isAvailable()`, `startScan()`, `stopScan()`, `startAdvertising()`, `stopAdvertising()`, `connect(peerId)`, `disconnect(peerId)`, `sendMessage(peerId,text)`.
Native callbacks: `window.onEKOOLBluetoothPeers(json)`, `window.onEKOOLBluetoothState(json)`, `window.onEKOOLBluetoothMessage(json)`.

## Build and status
Open `android-app/` in Android Studio with a current Android SDK. The shell loads the production EKOOOL URL. This branch is an initial Android/BLE foundation, not a production-ready messenger: physical-device tests, peer consent, authenticated encryption, reconnect logic, ordering, permission flows, and offline history still need implementation and validation.
