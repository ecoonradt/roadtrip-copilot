package com.roadtrip.copilot

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.view.View
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Toast
import android.util.Log
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.google.gson.Gson
import com.roadtrip.copilot.databinding.ActivityMainBinding
import com.roadtrip.copilot.model.Itinerary
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import java.io.InputStreamReader
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

data class RouteOption(
    val title: String,
    val routeFile: String,
    val dayNumber: Int
) {
    override fun toString(): String = title
}

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private var copilotService: CopilotService? = null
    private var isBound = false
    private var routeOptions: List<RouteOption> = emptyList()

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
                        putExtra(CopilotService.EXTRA_ROUTE_FILE, "test_itinerary.json")
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        setupRouteSpinner()
        setupListeners()
        observeServiceState()
        handleTestAction(intent)
    }

    override fun onStart() {
        super.onStart()
        val intent = Intent(this, CopilotService::class.java)
        bindService(intent, serviceConnection, Context.BIND_AUTO_CREATE)
    }

    override fun onStop() {
        super.onStop()
        if (isBound) {
            unbindService(serviceConnection)
            isBound = false
        }
    }

    private fun setupRouteSpinner() {
        routeOptions = loadRouteOptions()
        val adapter = ArrayAdapter(this, R.layout.spinner_item, routeOptions)
        adapter.setDropDownViewResource(R.layout.spinner_dropdown_item)
        binding.spinnerRoute.adapter = adapter

        val prefs = getSharedPreferences("copilot_prefs", Context.MODE_PRIVATE)
        val lastSelected = prefs.getInt("pref_selected_route_idx", 0)
        if (lastSelected in routeOptions.indices) {
            binding.spinnerRoute.setSelection(lastSelected)
        }

        binding.spinnerRoute.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                prefs.edit().putInt("pref_selected_route_idx", position).apply()
            }
            override fun onNothingSelected(parent: AdapterView<*>?) {}
        }
    }

    private fun loadRouteOptions(): List<RouteOption> {
        val options = mutableListOf<RouteOption>()
        val gson = Gson()

        // 1. Return Test Run
        try {
            assets.open("test_itinerary_return.json").use { stream ->
                val it = gson.fromJson(InputStreamReader(stream), Itinerary::class.java)
                val title = if (!it.tripName.isNullOrBlank()) it.tripName else "Return Run: Nassau to Albany"
                options.add(RouteOption(title, "test_itinerary_return.json", 1))
            }
        } catch (e: Exception) {
            options.add(RouteOption("Return Run: Nassau to Albany", "test_itinerary_return.json", 1))
        }

        // 2. Test Run
        try {
            assets.open("test_itinerary.json").use { stream ->
                val it = gson.fromJson(InputStreamReader(stream), Itinerary::class.java)
                val title = if (!it.tripName.isNullOrBlank()) it.tripName else "Test Run: Albany to Nassau"
                options.add(RouteOption(title, "test_itinerary.json", 1))
            }
        } catch (e: Exception) {
            options.add(RouteOption("Test Run: Albany to Nassau", "test_itinerary.json", 1))
        }

        // 3. Phoenix to Albuquerque Days
        try {
            assets.open("itinerary.json").use { stream ->
                val it = gson.fromJson(InputStreamReader(stream), Itinerary::class.java)
                it.days?.forEach { day ->
                    val title = if (!day.title.isNullOrBlank()) {
                        "Day ${day.day}: ${day.title}"
                    } else {
                        "Day ${day.day}"
                    }
                    options.add(RouteOption(title, "itinerary.json", day.day))
                }
            }
        } catch (e: Exception) {
            Log.e("MainActivity", "Failed to load itinerary.json", e)
        }

        return options
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
                val selectedIdx = binding.spinnerRoute.selectedItemPosition
                val selectedRoute = routeOptions.getOrNull(selectedIdx)
                val routeFile = selectedRoute?.routeFile ?: "test_itinerary.json"
                val dayNum = selectedRoute?.dayNumber ?: 1
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
                val selectedIdx = binding.spinnerRoute.selectedItemPosition
                val selectedRoute = routeOptions.getOrNull(selectedIdx)
                val routeFile = selectedRoute?.routeFile ?: "test_itinerary.json"
                val dayNum = selectedRoute?.dayNumber ?: 1
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
        val selectedIdx = binding.spinnerRoute.selectedItemPosition
        val selectedRoute = routeOptions.getOrNull(selectedIdx) ?: return

        val intent = Intent(this, CopilotService::class.java).apply {
            action = CopilotService.ACTION_START
            putExtra(CopilotService.EXTRA_ROUTE_FILE, selectedRoute.routeFile)
            putExtra(CopilotService.EXTRA_DAY_NUMBER, selectedRoute.dayNumber)
        }

        ContextCompat.startForegroundService(this, intent)
    }

    private fun stopCopilotService() {
        val intent = Intent(this, CopilotService::class.java).apply {
            action = CopilotService.ACTION_STOP
        }
        startService(intent)
    }

    private fun observeServiceState() {
        lifecycleScope.launch {
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

        lifecycleScope.launch {
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

        lifecycleScope.launch {
            CopilotService.eventLogFlow.collectLatest { logMsg ->
                appendLog(logMsg)
            }
        }
    }

    private fun appendLog(msg: String) {
        val time = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())
        val currentText = binding.tvEventLog.text.toString()
        binding.tvEventLog.text = "[$time] $msg\n$currentText"
    }
}
