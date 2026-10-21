# EKOOOL Bluetooth — Android architecture

## Goal
Experimental direct device-to-device messaging between nearby Android installs. Chat payloads travel over BLE GATT rather than through the EKOOOL web server.

## Components
- `android-app/`: native Android WebView shell for the existing EKOOOL web client.
- `BleBridge`: JavaScript interface exposed to the EKOOOL client.
- `BleDiscovery`: BLE scanning/advertising, a GATT server, outbound GATT connections, notifications and writes.
- Existing `index.html`: Settings entry, device list, per-peer connection prompt, and an in-screen message composer.
- Existing Node server: still hosts the web client and account data; this BLE transport does not post chat text to it.

## Current prototype behavior
1. A user explicitly starts advertising and/or scanning.
2. The user taps a discovered device and confirms that they want to request a connection.
3. The receiving device gets a separate approval prompt. Until approval, the GATT server rejects message writes.
4. After approval, text messages are exchanged directly over GATT.
5. Messages are currently limited to 180 UTF-8 bytes each. Long-message fragmentation, retry, ordering and delivery acknowledgements are not implemented.

## Security limitations — not production-ready
- The prototype does **not** implement authenticated end-to-end encryption. Do not send passwords, verification codes, financial information or other sensitive content.
- A BLE address is a transport identifier, not a verified EKOOOL account identity; addresses can change or be spoofed.
- Approval currently relies on a UI prompt and transport-level identifiers. It is not a cryptographic identity check.
- There is no persistent encrypted message history, reconnect queue, multi-peer session management, or background reliability.
- Bluetooth link security may vary by device and pairing state; GATT alone is not end-to-end encryption.
- Do not silently upload Bluetooth message bodies to the server.

## Web bridge
- `isAvailable()`
- `startScan()`, `stopScan()`
- `startAdvertising()`, `stopAdvertising()`
- `connect(peerId)`, `acceptPeer(peerId, accepted)`, `disconnect(peerId)`
- `sendMessage(peerId, text)`

Native callbacks:
- `window.onEKOOLBluetoothPeers(json)`
- `window.onEKOOLBluetoothState(json)`
- `window.onEKOOLBluetoothMessage(json)`

## Build and validation status
Open `android-app/` in Android Studio with a current Android SDK. The shell loads the production EKOOOL URL. The branch has not yet been built with Android Gradle or tested on two physical Android devices. Before release, compile and test on Android 8–15 devices, verify both connection directions, reject/accept paths, reconnect/disconnect, BLE payload limits, permission denial, and service lifecycle. Then implement authenticated key agreement (e.g. X25519), AEAD encryption, replay protection, cryptographic peer verification, encrypted local history and robust message framing.
