package com.roadtrip.copilot

import android.Manifest
import android.content.ComponentName
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.provider.OpenableColumns
import android.util.Log
import android.view.View
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import com.roadtrip.copilot.databinding.ActivityMainBinding
import com.roadtrip.copilot.model.RouteOption
import com.roadtrip.copilot.model.RouteRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

data class TripGroup(
    val title: String,
    val routeFile: String,
    val isAsset: Boolean,
    val days: List<RouteOption>
) {
    override fun toString(): String {
        return if (days.size > 1 && !title.contains("Days", ignoreCase = true)) {
            "$title (${days.size} Days)"
        } else {
            title
        }
    }
}

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private var copilotService: CopilotService? = null
    private var isBound = false
    private var routeOptions: List<RouteOption> = emptyList()
    private var tripGroups: List<TripGroup> = emptyList()
    private var tripAdapter: ArrayAdapter<TripGroup>? = null
    private var dayAdapter: ArrayAdapter<RouteOption>? = null

    private var isAudioSetupExpanded = false
    private var isEventLogExpanded = false
    private var eventCount = 0

    private val importLauncher = registerForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri: Uri? ->
        if (uri != null) {
            importItineraryFromUri(uri)
        }
    }

    private val serviceConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            val binder = service as CopilotService.LocalBinder
            copilotService = binder.getService()
            isBound = true
            copilotService?.setPauseMusicInsteadOfDuck(binding.switchPauseMusic.isChecked)
            handleIncomingIntent(intent)
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            copilotService = null
            isBound = false
        }
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIncomingIntent(intent)
    }

    private fun handleIncomingIntent(intent: Intent?) {
        if (intent == null) return
        handleTestAction(intent)

        if (intent.action == Intent.ACTION_VIEW && intent.data != null) {
            val uri = intent.data!!
            intent.data = null
            intent.action = null
            appendLog("Opened from link / camera scan: $uri")
            handleScannedContent(uri.toString())
        }
    }

    private fun handleTestAction(intent: Intent?) {
        val action = intent?.getStringExtra("test_action") ?: return
        intent.removeExtra("test_action")
        when (action) {
            "test_alert" -> {
                if (copilotService != null) {
                    copilotService?.testAlert()
                } else {
                    val sIntent = Intent(this, CopilotService::class.java).apply {
                        setAction(CopilotService.ACTION_START)
                        putExtra(CopilotService.EXTRA_ROUTE_FILE, "sample_itinerary.json")
                        putExtra(CopilotService.EXTRA_DAY_NUMBER, 1)
                    }
                    ContextCompat.startForegroundService(this, sIntent)
                }
            }
            "test_audio" -> {
                copilotService?.testAudio()
            }
            "calibrate_audio" -> {
                copilotService?.calibrateAudio()
            }
            "start_route" -> {
                startCopilotService()
            }
            "stop_route" -> {
                stopCopilotService()
            }
        }
    }

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { permissions ->
        val fineLocation = permissions[Manifest.permission.ACCESS_FINE_LOCATION] ?: false
        val coarseLocation = permissions[Manifest.permission.ACCESS_COARSE_LOCATION] ?: false
        val notifications = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            permissions[Manifest.permission.POST_NOTIFICATIONS] ?: false
        } else true

        if (!notifications) {
            appendLog("Notice: Notification permission not granted. Heads-up cards will be disabled.")
        }

        if (fineLocation || coarseLocation) {
            appendLog("Location permission granted.")
            startCopilotService()
        } else {
            Toast.makeText(this, "Location permission is required for GPS tracking.", Toast.LENGTH_LONG).show()
            appendLog("Error: Location permission denied.")
        }
    }

    private fun startQrScanner() {
        val options = GmsBarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .enableAutoZoom()
            .build()
        val scanner = GmsBarcodeScanning.getClient(this, options)
        scanner.startScan()
            .addOnSuccessListener { barcode ->
                val rawValue = barcode.rawValue
                if (!rawValue.isNullOrBlank()) {
                    handleScannedContent(rawValue)
                } else {
                    Toast.makeText(this, "Empty QR code detected.", Toast.LENGTH_SHORT).show()
                }
            }
            .addOnCanceledListener {
                // User closed scanner sheet
            }
            .addOnFailureListener { e ->
                Log.e(TAG, "QR scan error", e)
                Toast.makeText(this, "QR Scanner error: ${e.localizedMessage ?: "Unknown error"}", Toast.LENGTH_SHORT).show()
            }
    }

    private fun handleScannedContent(raw: String) {
        val trimmed = raw.trim()
        val targetUrl = when {
            trimmed.startsWith("http://", ignoreCase = true) || trimmed.startsWith("https://", ignoreCase = true) -> trimmed
            trimmed.startsWith("roadtrip-copilot://", ignoreCase = true) || trimmed.startsWith("roadtrip://", ignoreCase = true) -> {
                val parsed = Uri.parse(trimmed)
                parsed.getQueryParameter("url") ?: trimmed.substringAfter("://")
            }
            else -> null
        }

        if (targetUrl != null && (targetUrl.startsWith("http://", ignoreCase = true) || targetUrl.startsWith("https://", ignoreCase = true))) {
            downloadAndImportItinerary(targetUrl)
        } else if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
            importItineraryFromJsonString(trimmed, "scanned_itinerary.json")
        } else {
            Toast.makeText(this, "Unrecognized QR code format: $trimmed", Toast.LENGTH_LONG).show()
            appendLog("Warning: Unrecognized QR code content: $trimmed")
        }
    }

    private fun downloadAndImportItinerary(url: String) {
        binding.tvStatusBadge.text = "Downloading Route..."
        appendLog("Downloading itinerary from: $url")
        Toast.makeText(this, "Downloading route...", Toast.LENGTH_SHORT).show()

        lifecycleScope.launch {
            try {
                val (jsonContent, suggestedFileName) = withContext(Dispatchers.IO) {
                    val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                        connectTimeout = 8000
                        readTimeout = 12000
                        requestMethod = "GET"
                        instanceFollowRedirects = true
                    }
                    try {
                        val code = conn.responseCode
                        if (code !in 200..299) {
                            throw java.io.IOException("HTTP $code ${conn.responseMessage}")
                        }

                        var headerFileName: String? = null
                        val disp = conn.getHeaderField("Content-Disposition")
                        if (!disp.isNullOrBlank() && disp.contains("filename=")) {
                            headerFileName = disp.substringAfter("filename=").trim('"', ' ', '\'')
                        }
                        if (headerFileName.isNullOrBlank()) {
                            headerFileName = url.substringAfterLast('/').substringBefore('?')
                        }
                        val cleanFileName = if (!headerFileName.isNullOrBlank() && headerFileName.endsWith(".json", ignoreCase = true)) {
                            File(headerFileName).name
                        } else {
                            "imported_trip.json"
                        }

                        val text = conn.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
                        Pair(text, cleanFileName)
                    } finally {
                        conn.disconnect()
                    }
                }

                importItineraryFromJsonString(jsonContent, suggestedFileName)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to download route from $url", e)
                Toast.makeText(this@MainActivity, "Download failed: ${e.localizedMessage ?: e.message}", Toast.LENGTH_LONG).show()
                appendLog("Error downloading route: ${e.message}")
                val isRunning = CopilotService.isRunning.value
                binding.tvStatusBadge.text = if (isRunning) getString(R.string.status_running) else getString(R.string.status_idle)
            }
        }
    }

    private fun resolveFileName(uri: Uri): String {
        var name: String? = null
        if (uri.scheme == ContentResolver.SCHEME_CONTENT) {
            try {
                contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                    if (cursor.moveToFirst()) {
                        val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        if (nameIndex != -1) {
                            name = cursor.getString(nameIndex)
                        }
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "Failed to resolve display name from uri: $uri", e)
            }
        }
        if (name.isNullOrBlank()) {
            name = uri.lastPathSegment?.substringAfterLast('/')
        }
        val resolvedName = if (!name.isNullOrBlank()) name!! else "custom_itinerary.json"
        val cleanName = File(resolvedName).name
        return if (cleanName.endsWith(".json", ignoreCase = true)) cleanName else "$cleanName.json"
    }

    private fun importItineraryFromUri(uri: Uri) {
        lifecycleScope.launch {
            try {
                val fileName = resolveFileName(uri)
                val jsonContent = withContext(Dispatchers.IO) {
                    contentResolver.openInputStream(uri)?.use { inputStream ->
                        inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
                    } ?: throw IllegalStateException("Could not read itinerary from selected file")
                }
                importItineraryFromJsonString(jsonContent, fileName)
            } catch (e: SecurityException) {
                Log.e(TAG, "Permission denied importing itinerary", e)
                Toast.makeText(this@MainActivity, "Permission denied accessing file: ${e.localizedMessage}", Toast.LENGTH_LONG).show()
                appendLog("Error: Permission denied reading file.")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to import itinerary", e)
                Toast.makeText(this@MainActivity, "Import failed: ${e.localizedMessage ?: "Unknown error"}", Toast.LENGTH_LONG).show()
                appendLog("Error importing itinerary: ${e.message}")
            }
        }
    }

    private fun importItineraryFromJsonString(jsonContent: String, fileName: String) {
        lifecycleScope.launch {
            try {
                val targetDir = File(filesDir, "itineraries")
                if (!targetDir.exists()) {
                    targetDir.mkdirs()
                }
                val safeFileName = if (fileName.endsWith(".json", ignoreCase = true)) File(fileName).name else "${File(fileName).name}.json"
                val targetFile = File(targetDir, safeFileName)

                val importedOption = withContext(Dispatchers.IO) {
                    targetFile.writeText(jsonContent, Charsets.UTF_8)
                    val repo = RouteRepository.getInstance(applicationContext)
                    val updatedRoutes = repo.refreshRoutes()
                    updatedRoutes.find { it.routeFile == targetFile.name }
                }

                if (importedOption != null) {
                    val isRunning = CopilotService.isRunning.value
                    CopilotService.setSelectedRoute(
                        this@MainActivity,
                        importedOption.routeFile,
                        importedOption.dayNumber,
                        autoRestartIfRunning = isRunning
                    )
                    binding.tvStatusBadge.text = if (isRunning) getString(R.string.status_running) else getString(R.string.status_idle)
                    Toast.makeText(this@MainActivity, "Trip Loaded: ${importedOption.title}", Toast.LENGTH_SHORT).show()
                    appendLog("Trip loaded: ${importedOption.title} (${importedOption.routeFile})")
                } else {
                    val isRunning = CopilotService.isRunning.value
                    binding.tvStatusBadge.text = if (isRunning) getString(R.string.status_running) else getString(R.string.status_idle)
                    Toast.makeText(
                        this@MainActivity,
                        "File $safeFileName saved, but contains no valid waypoints.",
                        Toast.LENGTH_LONG
                    ).show()
                    appendLog("Warning: $safeFileName saved but contains no valid checkpoints or days.")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to save itinerary", e)
                val isRunning = CopilotService.isRunning.value
                binding.tvStatusBadge.text = if (isRunning) getString(R.string.status_running) else getString(R.string.status_idle)
                Toast.makeText(this@MainActivity, "Save failed: ${e.localizedMessage ?: e.message}", Toast.LENGTH_LONG).show()
                appendLog("Error saving itinerary: ${e.message}")
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        CopilotService.loadInitialRoute(this)
        setupRouteSpinner()
        setupListeners()
        observeServiceState()
        handleIncomingIntent(intent)

        lifecycleScope.launch {
            RouteRepository.getInstance(this@MainActivity).refreshRoutes()
        }
    }

    override fun onStart() {
        super.onStart()
        val intent = Intent(this, CopilotService::class.java)
        bindService(intent, serviceConnection, Context.BIND_AUTO_CREATE)
    }

    override fun onResume() {
        super.onResume()
        val prefs = getSharedPreferences("copilot_prefs", Context.MODE_PRIVATE)
        binding.switchPauseMusic.isChecked = prefs.getBoolean("pref_pause_music", true)
        lifecycleScope.launch {
            RouteRepository.getInstance(this@MainActivity).refreshRoutes()
            val currentFile = CopilotService.activeRouteFile.value
            val currentDay = CopilotService.activeDayNumber.value
            if (currentFile.isNotBlank()) {
                if (!CopilotService.isRunning.value) {
                    CopilotService.setSelectedRoute(
                        this@MainActivity,
                        currentFile,
                        currentDay,
                        autoRestartIfRunning = false
                    )
                } else {
                    syncSelectionFromServiceState(currentFile, currentDay)
                }
            }
        }
    }

    override fun onStop() {
        super.onStop()
        if (isBound) {
            unbindService(serviceConnection)
            isBound = false
        }
    }

    private fun buildTripGroups(routes: List<RouteOption>): List<TripGroup> {
        val grouped = LinkedHashMap<String, MutableList<RouteOption>>()
        for (opt in routes) {
            val key = if (opt.isAsset) "asset:${opt.routeFile}" else "file:${opt.routeFile}"
            grouped.getOrPut(key) { mutableListOf() }.add(opt)
        }
        return grouped.map { (_, daysList) ->
            val first = daysList.first()
            val distinctDays = daysList.distinctBy { it.dayNumber }.sortedBy { it.dayNumber }
            val title = first.tripName?.takeIf { it.isNotBlank() }
                ?: if (distinctDays.size == 1) first.title else first.routeFile.removeSuffix(".json").replace('_', ' ').replace('-', ' ').trim()
            TripGroup(
                title = title,
                routeFile = first.routeFile,
                isAsset = first.isAsset,
                days = distinctDays
            )
        }
    }

    private fun getSelectedRouteOption(): RouteOption? {
        val tripIdx = binding.spinnerRoute.selectedItemPosition
        val trip = tripGroups.getOrNull(tripIdx) ?: return null
        return if (trip.days.size > 1) {
            val dayIdx = binding.spinnerDay.selectedItemPosition
            trip.days.getOrNull(dayIdx) ?: trip.days.firstOrNull()
        } else {
            trip.days.firstOrNull()
        }
    }

    private fun handleTripSelection(trip: TripGroup) {
        if (trip.days.size > 1) {
            binding.layoutDaySelect.visibility = View.VISIBLE
            dayAdapter?.apply {
                clear()
                addAll(trip.days)
                notifyDataSetChanged()
            }
            val targetDayNum = if (trip.routeFile == CopilotService.activeRouteFile.value) {
                CopilotService.activeDayNumber.value
            } else {
                1
            }
            val dayIdx = trip.days.indexOfFirst { it.dayNumber == targetDayNum }.coerceAtLeast(0)
            if (binding.spinnerDay.selectedItemPosition != dayIdx) {
                binding.spinnerDay.setSelection(dayIdx)
            }
            val selectedDay = trip.days.getOrNull(dayIdx) ?: return
            if (selectedDay.routeFile != CopilotService.activeRouteFile.value ||
                selectedDay.dayNumber != CopilotService.activeDayNumber.value) {
                val running = CopilotService.isRunning.value
                CopilotService.setSelectedRoute(this, selectedDay.routeFile, selectedDay.dayNumber, autoRestartIfRunning = running)
            }
        } else {
            binding.layoutDaySelect.visibility = View.GONE
            dayAdapter?.apply {
                clear()
                notifyDataSetChanged()
            }
            val selectedDay = trip.days.firstOrNull() ?: return
            if (selectedDay.routeFile != CopilotService.activeRouteFile.value ||
                selectedDay.dayNumber != CopilotService.activeDayNumber.value) {
                val running = CopilotService.isRunning.value
                CopilotService.setSelectedRoute(this, selectedDay.routeFile, selectedDay.dayNumber, autoRestartIfRunning = running)
            }
        }
    }

    private fun syncSelectionFromServiceState(
        file: String = CopilotService.activeRouteFile.value,
        day: Int = CopilotService.activeDayNumber.value
    ) {
        val tripIdx = tripGroups.indexOfFirst { it.routeFile == file }
        if (tripIdx >= 0) {
            if (binding.spinnerRoute.selectedItemPosition != tripIdx) {
                binding.spinnerRoute.setSelection(tripIdx)
            }
            val trip = tripGroups[tripIdx]
            if (trip.days.size > 1) {
                binding.layoutDaySelect.visibility = View.VISIBLE
                dayAdapter?.clear()
                dayAdapter?.addAll(trip.days)
                dayAdapter?.notifyDataSetChanged()
                val dayIdx = trip.days.indexOfFirst { it.dayNumber == day }.coerceAtLeast(0)
                if (binding.spinnerDay.selectedItemPosition != dayIdx) {
                    binding.spinnerDay.setSelection(dayIdx)
                }
            } else {
                binding.layoutDaySelect.visibility = View.GONE
            }
        }
    }

    private fun setupRouteSpinner() {
        routeOptions = RouteRepository.getInstance(this).getRouteOptions()
        tripGroups = buildTripGroups(routeOptions)

        tripAdapter = ArrayAdapter(this, R.layout.spinner_item, ArrayList(tripGroups)).apply {
            setDropDownViewResource(R.layout.spinner_dropdown_item)
        }
        binding.spinnerRoute.adapter = tripAdapter

        dayAdapter = ArrayAdapter(this, R.layout.spinner_item, ArrayList<RouteOption>()).apply {
            setDropDownViewResource(R.layout.spinner_dropdown_item)
        }
        binding.spinnerDay.adapter = dayAdapter

        binding.spinnerRoute.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                val trip = tripGroups.getOrNull(position) ?: return
                handleTripSelection(trip)
            }

            override fun onNothingSelected(parent: AdapterView<*>?) {}
        }

        binding.spinnerDay.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                val tripIdx = binding.spinnerRoute.selectedItemPosition
                val trip = tripGroups.getOrNull(tripIdx) ?: return
                if (trip.days.size > 1) {
                    val selectedDay = trip.days.getOrNull(position) ?: return
                    if (selectedDay.routeFile != CopilotService.activeRouteFile.value ||
                        selectedDay.dayNumber != CopilotService.activeDayNumber.value) {
                        val running = CopilotService.isRunning.value
                        CopilotService.setSelectedRoute(this@MainActivity, selectedDay.routeFile, selectedDay.dayNumber, autoRestartIfRunning = running)
                    }
                }
            }

            override fun onNothingSelected(parent: AdapterView<*>?) {}
        }

        syncSelectionFromServiceState()
    }

    private fun toggleAudioSetup() {
        isAudioSetupExpanded = !isAudioSetupExpanded
        binding.layoutAudioBody.visibility = if (isAudioSetupExpanded) View.VISIBLE else View.GONE
        binding.ivAudioChevron.animate().rotation(if (isAudioSetupExpanded) 180f else 0f).setDuration(200).start()
    }

    private fun toggleEventLog() {
        isEventLogExpanded = !isEventLogExpanded
        binding.layoutLogBody.visibility = if (isEventLogExpanded) View.VISIBLE else View.GONE
        binding.ivLogChevron.animate().rotation(if (isEventLogExpanded) 180f else 0f).setDuration(200).start()
    }

    private fun updateLogCount() {
        binding.tvLogCount.text = "$eventCount events"
    }

    private fun setupListeners() {
        binding.btnScanQr.setOnClickListener {
            startQrScanner()
        }

        binding.layoutAudioHeader.setOnClickListener {
            toggleAudioSetup()
        }

        binding.layoutLogHeader.setOnClickListener {
            toggleEventLog()
        }

        binding.btnClearLog.setOnClickListener {
            binding.tvEventLog.text = ""
            eventCount = 0
            updateLogCount()
        }

        binding.btnToggleService.setOnClickListener {
            if (CopilotService.isRunning.value) {
                stopCopilotService()
            } else {
                checkPermissionsAndStart()
            }
        }

        binding.btnTestAudio.setOnClickListener {
            if (copilotService != null) {
                copilotService?.testAudio()
            } else {
                val selectedRoute = getSelectedRouteOption()
                val routeFile = selectedRoute?.routeFile ?: CopilotService.activeRouteFile.value
                val dayNum = selectedRoute?.dayNumber ?: CopilotService.activeDayNumber.value
                val intent = Intent(this, CopilotService::class.java).apply {
                    action = CopilotService.ACTION_START
                    putExtra(CopilotService.EXTRA_ROUTE_FILE, routeFile)
                    putExtra(CopilotService.EXTRA_DAY_NUMBER, dayNum)
                }
                ContextCompat.startForegroundService(this, intent)
                Toast.makeText(this, "Starting co-pilot for audio test...", Toast.LENGTH_SHORT).show()
            }
        }

        binding.btnTestAlert.setOnClickListener {
            if (copilotService != null) {
                copilotService?.testAlert()
            } else {
                val selectedRoute = getSelectedRouteOption()
                val routeFile = selectedRoute?.routeFile ?: CopilotService.activeRouteFile.value
                val dayNum = selectedRoute?.dayNumber ?: CopilotService.activeDayNumber.value
                val intent = Intent(this, CopilotService::class.java).apply {
                    action = CopilotService.ACTION_START
                    putExtra(CopilotService.EXTRA_ROUTE_FILE, routeFile)
                    putExtra(CopilotService.EXTRA_DAY_NUMBER, dayNum)
                }
                ContextCompat.startForegroundService(this, intent)
                Toast.makeText(this, "Starting co-pilot for alert test...", Toast.LENGTH_SHORT).show()
            }
        }

        binding.btnCalibrateAudio.setOnClickListener {
            if (copilotService != null) {
                copilotService?.calibrateAudio()
            } else {
                val intent = Intent(this, CopilotService::class.java).apply {
                    action = CopilotService.ACTION_CALIBRATE_AUDIO
                }
                ContextCompat.startForegroundService(this, intent)
                Toast.makeText(this, "Starting calibration speech...", Toast.LENGTH_SHORT).show()
            }
        }

        val prefs = getSharedPreferences("copilot_prefs", Context.MODE_PRIVATE)

        binding.switchPauseMusic.isChecked = prefs.getBoolean("pref_pause_music", true)
        binding.switchPauseMusic.setOnCheckedChangeListener { _, isChecked ->
            prefs.edit().putBoolean("pref_pause_music", isChecked).apply()
            copilotService?.setPauseMusicInsteadOfDuck(isChecked)
            appendLog("Audio mode: ${if (isChecked) "Pause music during alerts (Recommended)" else "Duck volume (subtle -14dB)"}")
        }

        binding.btnImportItinerary.setOnClickListener {
            try {
                importLauncher.launch(arrayOf("application/json", "text/plain", "*/*"))
            } catch (e: Exception) {
                Log.e(TAG, "Failed to launch document picker", e)
                Toast.makeText(this, "Could not open file picker: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun checkPermissionsAndStart() {
        val permissionsToRequest = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
        )

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            permissionsToRequest.add(Manifest.permission.POST_NOTIFICATIONS)
        }

        val allGranted = permissionsToRequest.all {
            ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
        }

        if (allGranted) {
            startCopilotService()
        } else {
            permissionLauncher.launch(permissionsToRequest.toTypedArray())
        }
    }

    private fun startCopilotService() {
        val selectedRoute = getSelectedRouteOption()
        val file = selectedRoute?.routeFile ?: CopilotService.activeRouteFile.value
        val day = selectedRoute?.dayNumber ?: CopilotService.activeDayNumber.value

        CopilotService.startRoute(this, file, day)
    }

    private fun stopCopilotService() {
        CopilotService.stopRoute(this)
    }

    private fun observeServiceState() {
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                launch {
                    RouteRepository.getInstance(this@MainActivity).routes.collectLatest { options ->
                        routeOptions = options
                        tripGroups = buildTripGroups(options)
                        tripAdapter?.apply {
                            clear()
                            addAll(tripGroups)
                            notifyDataSetChanged()
                        }
                        syncSelectionFromServiceState()
                    }
                }

                launch {
                    CopilotService.isRunning.collectLatest { running ->
                        if (running) {
                            binding.tvStatusBadge.text = getString(R.string.status_running)
                            binding.tvStatusBadge.backgroundTintList = ColorStateList.valueOf(getColor(R.color.success))
                            binding.tvStatusBadge.setTextColor(getColor(R.color.bg_dark))
                            binding.btnToggleService.text = getString(R.string.btn_stop)
                            binding.btnToggleService.backgroundTintList = ColorStateList.valueOf(getColor(R.color.danger))
                            binding.btnToggleService.setIconResource(0)
                        } else {
                            binding.tvStatusBadge.text = getString(R.string.status_idle)
                            binding.tvStatusBadge.backgroundTintList = ColorStateList.valueOf(0xFF334155.toInt())
                            binding.tvStatusBadge.setTextColor(getColor(R.color.text_light))
                            binding.btnToggleService.text = getString(R.string.btn_start)
                            binding.btnToggleService.backgroundTintList = ColorStateList.valueOf(getColor(R.color.accent))
                            binding.btnToggleService.setIconResource(R.drawable.ic_navigation)
                        }
                    }
                }

                launch {
                    CopilotService.telemetryFlow.collectLatest { result ->
                        if (result != null) {
                            binding.tvSpeed.text = "%.0f mph".format(result.speedMph)
                            if (result.nextCheckpoint != null) {
                                binding.tvNextWaypoint.text = result.nextCheckpoint.name
                                if (result.distanceToNextMiles != null) {
                                    binding.tvDistanceNext.text = "%.1f mi away".format(result.distanceToNextMiles)
                                } else {
                                    val count = CopilotService.activeCheckpoints.value.size
                                    binding.tvDistanceNext.text = if (count > 0) "Ready • $count stops" else "Ready to depart"
                                }
                                val targetTime = result.nextCheckpoint.formattedTargetTime
                                binding.tvTargetTime.text = if (!targetTime.isNullOrBlank()) "Target: $targetTime" else "Target: Start"
                            } else {
                                binding.tvNextWaypoint.text = "All Checkpoints Visited"
                                binding.tvDistanceNext.text = "--"
                                binding.tvTargetTime.text = "Target: --"
                            }

                            if (result.scheduleDelta != null) {
                                binding.tvScheduleDelta.text = result.scheduleDelta.statusText
                                val color = if (result.scheduleDelta.isAhead) getColor(R.color.success) else getColor(R.color.danger)
                                binding.tvScheduleDelta.setTextColor(color)
                            }
                        }
                    }
                }

                launch {
                    CopilotService.activeCheckpoints.collectLatest { checkpoints ->
                        if (!CopilotService.isRunning.value) {
                            val firstCp = checkpoints.firstOrNull()
                            if (firstCp != null) {
                                binding.tvNextWaypoint.text = firstCp.name
                                binding.tvDistanceNext.text = "Ready • ${checkpoints.size} stops"
                                val targetTime = firstCp.formattedTargetTime
                                binding.tvTargetTime.text = if (!targetTime.isNullOrBlank()) "Target: $targetTime" else "Target: Start"
                                binding.tvScheduleDelta.text = "Awaiting Departure"
                                binding.tvScheduleDelta.setTextColor(getColor(R.color.success))
                            } else {
                                binding.tvNextWaypoint.text = "-- None Selected --"
                                binding.tvDistanceNext.text = "--"
                                binding.tvTargetTime.text = "Target: --"
                            }
                        }
                    }
                }

                launch {
                    CopilotService.eventLogFlow.collectLatest { logMsg ->
                        appendLog(logMsg)
                    }
                }

                launch {
                    CopilotService.activeGoogleMapsUrl.collectLatest { url ->
                        updateGoogleMapsButton(url)
                    }
                }

                launch {
                    kotlinx.coroutines.flow.combine(
                        CopilotService.activeRouteFile,
                        CopilotService.activeDayNumber
                    ) { file, day -> Pair(file, day) }.collectLatest { (file, day) ->
                        syncSelectionFromServiceState(file, day)
                    }
                }
            }
        }
    }

    private fun updateGoogleMapsButton(serviceUrl: String?) {
        val selectedOption = getSelectedRouteOption()
        val url = serviceUrl ?: selectedOption?.googleMapsUrl
        if (!url.isNullOrBlank()) {
            binding.btnOpenGoogleMaps.visibility = View.VISIBLE
            binding.btnOpenGoogleMaps.setOnClickListener {
                openGoogleMapsNavigation(url)
            }
        } else {
            binding.btnOpenGoogleMaps.visibility = View.GONE
            binding.btnOpenGoogleMaps.setOnClickListener(null)
        }
    }

    private fun openGoogleMapsNavigation(url: String) {
        try {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                setPackage("com.google.android.apps.maps")
            }
            startActivity(intent)
        } catch (e: Exception) {
            try {
                val browserIntent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
                startActivity(browserIntent)
            } catch (fallbackEx: Exception) {
                Toast.makeText(this, "Could not open Google Maps navigation: ${fallbackEx.message}", Toast.LENGTH_SHORT).show()
                Log.e(TAG, "Failed to launch maps url: $url", fallbackEx)
            }
        }
    }

    private fun appendLog(msg: String) {
        val time = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())
        val currentText = binding.tvEventLog.text.toString()
        binding.tvEventLog.text = "[$time] $msg\n$currentText"
        eventCount++
        updateLogCount()
    }

    companion object {
        private const val TAG = "MainActivity"
    }
}
