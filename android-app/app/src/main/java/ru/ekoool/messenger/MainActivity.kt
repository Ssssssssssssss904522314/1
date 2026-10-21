package ru.ekoool.messenger

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.ParcelUuid
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.util.UUID

private val SERVICE_ID = UUID.fromString("2b6e0001-7f8a-4a3e-9c2d-4f6b9a001001")
private val RX_ID = UUID.fromString("2b6e0002-7f8a-4a3e-9c2d-4f6b9a001001")
private val TX_ID = UUID.fromString("2b6e0003-7f8a-4a3e-9c2d-4f6b9a001001")
private val CCCD_ID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
private const val MAX_MESSAGE_BYTES = 180

class MainActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var ble: BleDiscovery
    private val webUrl = "https://ekool-server.onrender.com/"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.webChromeClient = WebChromeClient()
        web.webViewClient = WebViewClient()
        ble = BleDiscovery(this) { callback, value ->
            val encoded = JSONObject.quote(value.toString())
            runOnUiThread { web.evaluateJavascript("window.$callback && window.$callback($encoded)", null) }
        }
        web.addJavascriptInterface(BleBridge(ble), "EKOOLBluetooth")
        setContentView(web)
        web.loadUrl(webUrl)
        requestBlePermissions()
    }

    private fun requestBlePermissions() {
        val permissions = if (Build.VERSION.SDK_INT >= 31)
            arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_ADVERTISE)
        else arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
        val missing = permissions.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) requestPermissions(missing.toTypedArray(), 41)
    }

    override fun onDestroy() { if (::ble.isInitialized) ble.close(); super.onDestroy() }
}

class BleBridge(private val ble: BleDiscovery) {
    @JavascriptInterface fun isAvailable() = ble.available()
    @JavascriptInterface fun startScan() = ble.startScan()
    @JavascriptInterface fun stopScan() { ble.stopScan() }
    @JavascriptInterface fun startAdvertising() = ble.startAdvertising()
    @JavascriptInterface fun stopAdvertising() { ble.stopAdvertising() }
    @JavascriptInterface fun connect(peerId: String) = ble.connect(peerId)
    @JavascriptInterface fun disconnect(peerId: String) { ble.disconnect(peerId) }
    @JavascriptInterface fun sendMessage(peerId: String, text: String) = ble.sendMessage(peerId, text)
}

@SuppressLint("MissingPermission")
class BleDiscovery(private val activity: Activity, private val emit: (String, JSONObject) -> Unit) {
    private val manager = activity.getSystemService(BLUETOOTH_SERVICE) as BluetoothManager
    private val adapter: BluetoothAdapter? get() = manager.adapter
    private var scanner: BluetoothLeScanner? = null
    private var advertiser: BluetoothLeAdvertiser? = null
    private var scanCallback: ScanCallback? = null
    private var advertiseCallback: AdvertiseCallback? = null
    private var gattServer: BluetoothGattServer? = null
    private val clients = mutableMapOf<String, BluetoothGatt>()
    private val peers = mutableMapOf<String, BluetoothGatt>()
    private val notifying = mutableSetOf<String>()
    private val txCharacteristic = BluetoothGattCharacteristic(
        TX_ID, BluetoothGattCharacteristic.PROPERTY_NOTIFY or BluetoothGattCharacteristic.PROPERTY_READ,
        BluetoothGattCharacteristic.PERMISSION_READ
    )
    private val rxCharacteristic = BluetoothGattCharacteristic(
        RX_ID, BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
        BluetoothGattCharacteristic.PERMISSION_WRITE
    )

    fun available() = adapter?.isEnabled == true

    fun startScan(): String {
        if (!available()) return "bluetooth_off"
        scanner = adapter?.bluetoothLeScanner ?: return "scanner_unavailable"
        stopScan()
        scanCallback = object : ScanCallback() {
            override fun onScanResult(type: Int, result: ScanResult) {
                emit("onEKOOLBluetoothPeers", JSONObject().put("id", result.device.address)
                    .put("name", result.scanRecord?.deviceName ?: "Устройство EKOOOL").put("rssi", result.rssi))
            }
            override fun onScanFailed(code: Int) {
                state("error", "scan_failed_$code")
            }
        }
        return try {
            scanner?.startScan(listOf(ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE_ID)).build()),
                ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), scanCallback)
            state("scanning")
            "ok"
        } catch (e: Exception) { state("error", "scan_start_failed"); "scan_failed" }
    }

    fun stopScan() {
        try { scanCallback?.let { scanner?.stopScan(it) } } catch (_: Exception) {}
        scanCallback = null
    }

    fun startAdvertising(): String {
        if (!available()) return "bluetooth_off"
        advertiser = adapter?.bluetoothLeAdvertiser ?: return "advertiser_unavailable"
        ensureGattServer()
        advertiseCallback = object : AdvertiseCallback() {
            override fun onStartSuccess(settings: AdvertiseSettings) { state("advertising") }
            override fun onStartFailure(code: Int) { state("error", "advertise_failed_$code") }
        }
        return try {
            val data = AdvertiseData.Builder().setIncludeDeviceName(false).addServiceUuid(ParcelUuid(SERVICE_ID)).build()
            advertiser?.startAdvertising(AdvertiseSettings.Builder().setConnectable(true)
                .setTimeout(0).setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM).build(), data, advertiseCallback)
            "ok"
        } catch (e: Exception) { state("error", "advertise_start_failed"); "advertise_failed" }
    }

    private fun ensureGattServer() {
        if (gattServer != null) return
        gattServer = manager.openGattServer(activity, object : BluetoothGattServerCallback() {
            override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
                val id = device.address
                if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                    emit("onEKOOLBluetoothState", JSONObject().put("status", "peer_connected").put("peerId", id))
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    clients.remove(id)?.close()
                    notifying.remove(id)
                    emit("onEKOOLBluetoothState", JSONObject().put("status", "peer_disconnected").put("peerId", id))
                }
            }

            override fun onCharacteristicWriteRequest(device: BluetoothDevice, requestId: Int,
                characteristic: BluetoothGattCharacteristic, preparedWrite: Boolean, responseNeeded: Boolean,
                offset: Int, value: ByteArray) {
                if (characteristic.uuid != RX_ID || offset != 0 || value.size > MAX_MESSAGE_BYTES) {
                    if (responseNeeded) gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_INVALID_ATTRIBUTE_LENGTH, offset, null)
                    return
                }
                val message = String(value, StandardCharsets.UTF_8)
                emit("onEKOOLBluetoothMessage", JSONObject().put("peerId", device.address).put("text", message).put("incoming", true))
                if (responseNeeded) gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null)
            }

            override fun onDescriptorWriteRequest(device: BluetoothDevice, requestId: Int,
                descriptor: BluetoothGattDescriptor, preparedWrite: Boolean, responseNeeded: Boolean,
                offset: Int, value: ByteArray) {
                if (descriptor.uuid == CCCD_ID) {
                    if (value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)) notifying.add(device.address)
                    else notifying.remove(device.address)
                }
                if (responseNeeded) gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
            }
        })
        val service = BluetoothGattService(SERVICE_ID, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        txCharacteristic.addDescriptor(BluetoothGattDescriptor(CCCD_ID,
            BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE))
        service.addCharacteristic(txCharacteristic)
        service.addCharacteristic(rxCharacteristic)
        gattServer?.addService(service)
    }

    private fun clientCallback(id: String) = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                state("error", "gatt_connection_failed")
                gatt.close()
                peers.remove(id)
                return
            }
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                peers[id] = gatt
                gatt.discoverServices()
                emit("onEKOOLBluetoothState", JSONObject().put("status", "connected").put("peerId", id))
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                peers.remove(id)
                gatt.close()
                emit("onEKOOLBluetoothState", JSONObject().put("status", "disconnected").put("peerId", id))
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            val service = gatt.getService(SERVICE_ID) ?: return state("error", "service_not_found")
            val tx = service.getCharacteristic(TX_ID) ?: return state("error", "notify_characteristic_missing")
            gatt.setCharacteristicNotification(tx, true)
            val cccd = tx.getDescriptor(CCCD_ID) ?: return state("error", "cccd_missing")
            cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
            if (Build.VERSION.SDK_INT >= 33) gatt.writeDescriptor(cccd) else @Suppress("DEPRECATION") run { gatt.writeDescriptor(cccd) }
        }

        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
            if (characteristic.uuid == TX_ID) emit("onEKOOLBluetoothMessage",
                JSONObject().put("peerId", id).put("text", String(value, StandardCharsets.UTF_8)).put("incoming", true))
        }

        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            if (Build.VERSION.SDK_INT < 33 && characteristic.uuid == TX_ID) emit("onEKOOLBluetoothMessage",
                JSONObject().put("peerId", id).put("text", String(characteristic.value ?: byteArrayOf(), StandardCharsets.UTF_8)).put("incoming", true))
        }
    }

    fun connect(peerId: String): String {
        if (!available()) return "bluetooth_off"
        return try {
            val device = adapter?.getRemoteDevice(peerId) ?: return "peer_not_found"
            device.connectGatt(activity, false, clientCallback(peerId), BluetoothDevice.TRANSPORT_LE)
            "connecting"
        } catch (e: Exception) { "connect_failed" }
    }

    fun sendMessage(peerId: String, text: String): String {
        val bytes = text.toByteArray(StandardCharsets.UTF_8)
        if (bytes.isEmpty()) return "empty_message"
        if (bytes.size > MAX_MESSAGE_BYTES) return "message_too_long"
        val gatt = peers[peerId]
        val characteristic = gatt?.getService(SERVICE_ID)?.getCharacteristic(RX_ID)
        return try {
            if (gatt != null && characteristic != null) {
                characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                if (Build.VERSION.SDK_INT >= 33) {
                    val result = gatt.writeCharacteristic(characteristic, bytes, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT)
                    if (result == BluetoothStatusCodes.SUCCESS) "ok" else "write_failed_$result"
                } else {
                    @Suppress("DEPRECATION")
                    characteristic.value = bytes
                    @Suppress("DEPRECATION")
                    if (gatt.writeCharacteristic(characteristic)) "ok" else "write_failed"
                }
            } else if (peerId in notifying && gattServer != null) {
                val device = adapter?.getRemoteDevice(peerId) ?: return "peer_not_found"
                if (Build.VERSION.SDK_INT >= 33) {
                    val result = gattServer!!.notifyCharacteristicChanged(device, txCharacteristic, false, bytes)
                    if (result == BluetoothStatusCodes.SUCCESS) "ok" else "notify_failed_$result"
                } else {
                    @Suppress("DEPRECATION")
                    txCharacteristic.value = bytes
                    @Suppress("DEPRECATION")
                    if (gattServer!!.notifyCharacteristicChanged(device, txCharacteristic, false)) "ok" else "notify_failed"
                }
            } else "not_connected"
        } catch (e: Exception) { "write_failed" }
    }

    fun disconnect(peerId: String) {
        peers.remove(peerId)?.let { try { it.disconnect(); it.close() } catch (_: Exception) {} }
        clients.remove(peerId)?.let { try { it.disconnect(); it.close() } catch (_: Exception) {} }
        notifying.remove(peerId)
    }

    fun stopAdvertising() {
        try { advertiseCallback?.let { advertiser?.stopAdvertising(it) } } catch (_: Exception) {}
        advertiseCallback = null
    }

    private fun state(status: String, detail: String? = null) {
        val value = JSONObject().put("status", status)
        if (detail != null) value.put("detail", detail)
        emit("onEKOOLBluetoothState", value)
    }

    fun close() {
        stopScan(); stopAdvertising()
        (peers.values + clients.values).distinct().forEach { try { it.disconnect(); it.close() } catch (_: Exception) {} }
        peers.clear(); clients.clear()
        try { gattServer?.close() } catch (_: Exception) {}
        gattServer = null
    }
}
