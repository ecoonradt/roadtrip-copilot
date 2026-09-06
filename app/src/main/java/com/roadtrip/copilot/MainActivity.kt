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
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.roadtrip.copilot.databinding.ActivityMainBinding
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private var copilotService: CopilotService? = null
    private var isBound = false

    private val serviceConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            val binder = service as CopilotService.LocalBinder
            copilotService = binder.getService()
            isBound = true
            copilotService?.setPauseMusicInsteadOfDuck(binding.switchPauseMusic.isChecked)
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            copilotService = null
            isBound = false
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
        val routes = listOf(
            "Nassau to Albany (Return Test Run)",
            "Albany to Nassau (NY 19-mi Test Run)",
            "Phoenix to Albuquerque (Day 1: PHX -> Flagstaff)",
            "Phoenix to Albuquerque (Day 2: Flagstaff -> Chama)",
            "Phoenix to Albuquerque (Day 3: Chama -> Taos)",
            "Phoenix to Albuquerque (Day 4: Taos -> Santa Fe -> ABQ)"
        )

        val adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, routes)
        binding.spinnerRoute.adapter = adapter
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
                // If service not started, start temporarily to speak test
                val intent = Intent(this, CopilotService::class.java).apply {
                    action = CopilotService.ACTION_START
                    putExtra(CopilotService.EXTRA_ROUTE_FILE, "test_itinerary.json")
                    putExtra(CopilotService.EXTRA_DAY_NUMBER, 1)
                }
                ContextCompat.startForegroundService(this, intent)
                Toast.makeText(this, "Starting service for audio test...", Toast.LENGTH_SHORT).show()
            }
        }

        binding.btnTestAlert.setOnClickListener {
            if (copilotService != null) {
                copilotService?.testAlert()
            } else {
                val intent = Intent(this, CopilotService::class.java).apply {
                    action = CopilotService.ACTION_START
                    putExtra(CopilotService.EXTRA_ROUTE_FILE, "test_itinerary.json")
                    putExtra(CopilotService.EXTRA_DAY_NUMBER, 1)
                }
                ContextCompat.startForegroundService(this, intent)
                Toast.makeText(this, "Starting service for alert test...", Toast.LENGTH_SHORT).show()
            }
        }

        val prefs = getSharedPreferences("copilot_prefs", Context.MODE_PRIVATE)
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
        val routeFile: String
        val dayNumber: Int

        when (selectedIdx) {
            0 -> {
                routeFile = "test_itinerary_return.json"
                dayNumber = 1
            }
            1 -> {
                routeFile = "test_itinerary.json"
                dayNumber = 1
            }
            2 -> {
                routeFile = "itinerary.json"
                dayNumber = 1
            }
            3 -> {
                routeFile = "itinerary.json"
                dayNumber = 2
            }
            4 -> {
                routeFile = "itinerary.json"
                dayNumber = 3
            }
            else -> {
                routeFile = "itinerary.json"
                dayNumber = 4
            }
        }

        val intent = Intent(this, CopilotService::class.java).apply {
            action = CopilotService.ACTION_START
            putExtra(CopilotService.EXTRA_ROUTE_FILE, routeFile)
            putExtra(CopilotService.EXTRA_DAY_NUMBER, dayNumber)
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
                    } else {
                        binding.tvNextWaypoint.text = "All Checkpoints Visited"
                        binding.tvDistanceNext.text = "--"
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
