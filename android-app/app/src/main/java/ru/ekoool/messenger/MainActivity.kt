package ru.ekoool.messenger

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
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
import java.util.UUID

private val SERVICE_ID = UUID.fromString("2b6e0001-7f8a-4a3e-9c2d-4f6b9a001001")

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
}

@SuppressLint("MissingPermission")
class BleDiscovery(private val activity: Activity, private val emit: (String, JSONObject) -> Unit) {
    private val manager = activity.getSystemService(BLUETOOTH_SERVICE) as BluetoothManager
    private val adapter: BluetoothAdapter? get() = manager.adapter
    private var scanner: BluetoothLeScanner? = null
    private var advertiser: BluetoothLeAdvertiser? = null
    private var scanCallback: ScanCallback? = null
    private var advertiseCallback: AdvertiseCallback? = null
    fun available() = adapter?.isEnabled == true

    fun startScan(): String {
        if (!available()) return "bluetooth_off"
        scanner = adapter?.bluetoothLeScanner
        scanCallback = object : ScanCallback() {
            override fun onScanResult(type: Int, result: ScanResult) {
                emit("onEKOOLBluetoothPeers", JSONObject().put("id", result.device.address)
                    .put("name", result.scanRecord?.deviceName ?: "Устройство EKOOOL").put("rssi", result.rssi))
            }
            override fun onScanFailed(code: Int) {
                emit("onEKOOLBluetoothState", JSONObject().put("status", "error").put("detail", code))
            }
        }
        val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE_ID)).build()
        scanner?.startScan(listOf(filter), ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), scanCallback)
        emit("onEKOOLBluetoothState", JSONObject().put("status", "scanning"))
        return "ok"
    }

    fun stopScan() { try { scanCallback?.let { scanner?.stopScan(it) } } catch (_: Exception) {}; scanCallback = null }

    fun startAdvertising(): String {
        if (!available()) return "bluetooth_off"
        advertiser = adapter?.bluetoothLeAdvertiser
        advertiseCallback = object : AdvertiseCallback() {
            override fun onStartSuccess(settings: AdvertiseSettings) {
                emit("onEKOOLBluetoothState", JSONObject().put("status", "advertising"))
            }
            override fun onStartFailure(code: Int) {
                emit("onEKOOLBluetoothState", JSONObject().put("status", "error").put("detail", code))
            }
        }
        val data = AdvertiseData.Builder().setIncludeDeviceName(false).addServiceUuid(ParcelUuid(SERVICE_ID)).build()
        advertiser?.startAdvertising(AdvertiseSettings.Builder().setConnectable(true).setTimeout(0).build(), data, advertiseCallback)
        return "ok"
    }

    fun stopAdvertising() { try { advertiseCallback?.let { advertiser?.stopAdvertising(it) } } catch (_: Exception) {}; advertiseCallback = null }
    fun close() { stopScan(); stopAdvertising() }
}
