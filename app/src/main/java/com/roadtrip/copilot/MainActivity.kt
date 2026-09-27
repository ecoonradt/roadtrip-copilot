package com.roadtrip.copilot

import android.Manifest
import android.content.ComponentName
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
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
import com.roadtrip.copilot.databinding.ActivityMainBinding
import com.roadtrip.copilot.model.RouteOption
import com.roadtrip.copilot.model.RouteRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
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
            copilotService?.setUseMediaStreamChannel(binding.switchUseMediaChannel.isChecked)
            handleTestAction(intent)
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            copilotService = null
            isBound = false
        }
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleTestAction(intent)
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
                val targetDir = File(filesDir, "itineraries")
                if (!targetDir.exists()) {
                    targetDir.mkdirs()
                }
                val targetFile = File(targetDir, fileName)

                val importedOption = withContext(Dispatchers.IO) {
                    contentResolver.openInputStream(uri)?.use { inputStream ->
                        targetFile.outputStream().use { outputStream ->
                            inputStream.copyTo(outputStream)
                        }
                    } ?: throw IllegalStateException("Could not read itinerary from selected file")

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
                    Toast.makeText(this@MainActivity, "Imported: ${importedOption.title}", Toast.LENGTH_SHORT).show()
                    appendLog("Imported custom itinerary: ${importedOption.title} (${importedOption.routeFile})")
                } else {
                    Toast.makeText(
                        this@MainActivity,
                        "File $fileName imported, but contained no valid waypoints.",
                        Toast.LENGTH_LONG
                    ).show()
                    appendLog("Warning: $fileName imported but contains no valid checkpoints or days.")
                }
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        CopilotService.loadInitialRoute(this)
        setupRouteSpinner()
        setupListeners()
        observeServiceState()
        handleTestAction(intent)

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
        binding.switchUseMediaChannel.isChecked = prefs.getBoolean("pref_use_media_stream", true)
        binding.switchPauseMusic.isChecked = prefs.getBoolean("pref_pause_music", false)
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
            grouped.getOrPut(opt.routeFile) { mutableListOf() }.add(opt)
        }
        return grouped.map { (file, daysList) ->
            val first = daysList.first()
            val title = first.tripName?.takeIf { it.isNotBlank() }
                ?: if (daysList.size == 1) first.title else file.removeSuffix(".json").replace('_', ' ').replace('-', ' ').trim()
            TripGroup(
                title = title,
                routeFile = file,
                isAsset = first.isAsset,
                days = daysList.sortedBy { it.dayNumber }
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
                if (dayAdapter?.count != trip.days.size) {
                    dayAdapter?.clear()
                    dayAdapter?.addAll(trip.days)
                    dayAdapter?.notifyDataSetChanged()
                }
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

    private fun setupListeners() {
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
                Toast.makeText(this, "Starting service for audio test...", Toast.LENGTH_SHORT).show()
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
                Toast.makeText(this, "Starting service for alert test...", Toast.LENGTH_SHORT).show()
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

        binding.switchUseMediaChannel.isChecked = prefs.getBoolean("pref_use_media_stream", true)
        binding.switchUseMediaChannel.setOnCheckedChangeListener { _, isChecked ->
            prefs.edit().putBoolean("pref_use_media_stream", isChecked).apply()
            copilotService?.setUseMediaStreamChannel(isChecked)
            appendLog("Audio channel: ${if (isChecked) "Media Stream (Matches car stereo volume knob)" else "Navigation Guidance Channel"}")
        }

        binding.switchPauseMusic.isChecked = prefs.getBoolean("pref_pause_music", false)
        binding.switchPauseMusic.setOnCheckedChangeListener { _, isChecked ->
            prefs.edit().putBoolean("pref_pause_music", isChecked).apply()
            copilotService?.setPauseMusicInsteadOfDuck(isChecked)
            appendLog("Audio mode: ${if (isChecked) "Pause music completely" else "Duck volume (Google Maps style)"}")
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
                            binding.tvStatusBadge.setBackgroundColor(getColor(R.color.success))
                            binding.tvStatusBadge.setTextColor(getColor(R.color.bg_dark))
                            binding.btnToggleService.text = getString(R.string.btn_stop)
                            binding.btnToggleService.setBackgroundColor(getColor(R.color.danger))
                        } else {
                            binding.tvStatusBadge.text = getString(R.string.status_idle)
                            binding.tvStatusBadge.setBackgroundColor(0xFF334155.toInt())
                            binding.tvStatusBadge.setTextColor(getColor(R.color.text_light))
                            binding.btnToggleService.text = getString(R.string.btn_start)
                            binding.btnToggleService.setBackgroundColor(getColor(R.color.accent))
                        }
                    }
                }

                launch {
                    CopilotService.telemetryFlow.collectLatest { result ->
                        if (result != null) {
                            binding.tvSpeed.text = "%.0f mph".format(result.speedMph)
                            if (result.nextCheckpoint != null && result.distanceToNextMiles != null) {
                                binding.tvNextWaypoint.text = result.nextCheckpoint.name
                                binding.tvDistanceNext.text = "%.1f mi away".format(result.distanceToNextMiles)
                                val targetTime = result.nextCheckpoint.formattedTargetTime
                                binding.tvTargetTime.text = if (!targetTime.isNullOrBlank()) "Target: $targetTime" else "Target: --"
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
                    CopilotService.eventLogFlow.collectLatest { logMsg ->
                        appendLog(logMsg)
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

    private fun appendLog(msg: String) {
        val time = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())
        val currentText = binding.tvEventLog.text.toString()
        binding.tvEventLog.text = "[$time] $msg\n$currentText"
    }

    companion object {
        private const val TAG = "MainActivity"
    }
}
