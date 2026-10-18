package com.roadtrip.copilot

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import java.util.Locale
import java.util.UUID

class AudioDuckEngine(
    private val context: Context,
    private val onSpeechStatusChanged: ((isSpeaking: Boolean, text: String) -> Unit)? = null,
    private val onSpeechFinished: (() -> Unit)? = null
) : TextToSpeech.OnInitListener {

    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var tts: TextToSpeech? = null
    private var isTtsReady = false
    private val pendingSpeechQueue = ArrayDeque<CharSequence>()

    private var currentFocusRequest: AudioFocusRequest? = null
    private var currentFocusGain: Int? = null
    @Volatile
    private var activeUtteranceId: String? = null

    companion object {
        private const val TAG = "AudioDuckEngine"
    }

    init {
        tts = TextToSpeech(context.applicationContext, this)
    }

    override fun onInit(status: Int) {
        if (status == TextToSpeech.SUCCESS) {
            val result = tts?.setLanguage(Locale.US)
            if (result == TextToSpeech.LANG_MISSING_DATA || result == TextToSpeech.LANG_NOT_SUPPORTED) {
                Log.w(TAG, "US English voice data missing or not supported.")
            } else {
                isTtsReady = true
                applyCurrentAudioAttributes()
                Log.i(TAG, "Offline TextToSpeech initialized successfully.")
            }

            tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) {
                    Log.d(TAG, "TTS speech started: $utteranceId")
                }

                override fun onDone(utteranceId: String?) {
                    Log.d(TAG, "TTS speech completed: $utteranceId. Restoring audio focus.")
                    if (utteranceId == activeUtteranceId) {
                        abandonFocus()
                        onSpeechStatusChanged?.invoke(false, "")
                        onSpeechFinished?.invoke()
                    }
                }

                override fun onStop(utteranceId: String?, interrupted: Boolean) {
                    Log.d(TAG, "TTS speech stopped (interrupted=$interrupted): $utteranceId")
                    if (utteranceId == activeUtteranceId) {
                        abandonFocus()
                        onSpeechStatusChanged?.invoke(false, "")
                    }
                }

                @Deprecated("Deprecated in Java")
                override fun onError(utteranceId: String?) {
                    Log.e(TAG, "TTS speech error on $utteranceId. Restoring audio focus.")
                    if (utteranceId == activeUtteranceId) {
                        abandonFocus()
                        onSpeechStatusChanged?.invoke(false, "")
                        onSpeechFinished?.invoke()
                    }
                }

                override fun onError(utteranceId: String?, errorCode: Int) {
                    Log.e(TAG, "TTS speech error code $errorCode on $utteranceId. Restoring audio focus.")
                    if (utteranceId == activeUtteranceId) {
                        abandonFocus()
                        onSpeechStatusChanged?.invoke(false, "")
                        onSpeechFinished?.invoke()
                    }
                }
            })

            // Flush any speech that was requested before TTS finished initializing
            if (isTtsReady) {
                var first = true
                while (pendingSpeechQueue.isNotEmpty()) {
                    val queued = pendingSpeechQueue.removeFirst()
                    val mode = if (first) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
                    speakWithDucking(queued, mode)
                    first = false
                }
            }
        } else {
            Log.e(TAG, "TTS initialization failed with status: $status")
        }
    }

    /**
     * Defaults to true (AUDIOFOCUS_GAIN_TRANSIENT). Standard Android ducking (MAY_DUCK) only
     * attenuates by -14 dB (DUCK_VSHAPE), which is inaudible over car/road noise when mixed
     * across Android Auto's dual-channel projection. Pausing guarantees complete speech clarity.
     * Architectural Invariant: Do not revert default focus gain to MAY_DUCK or attempt volume
     * slider hacks (setStreamVolume) to bypass audio focus mechanics.
     */
    var pauseMusicInsteadOfDuck: Boolean = true

    fun applyCurrentAudioAttributes() {
        val speechAttributes = getSpeechAudioAttributes()
        tts?.setAudioAttributes(speechAttributes)
    }

    private fun getSpeechAudioAttributes(): AudioAttributes {
        return AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()
    }

    /**
     * Pauses active media or ducks it, speaks the provided text through
     * the navigation guidance audio channel, and immediately restores music on completion.
     */
    fun speakWithDucking(text: CharSequence, queueMode: Int = TextToSpeech.QUEUE_FLUSH) {
        if (text.isBlank()) {
            return
        }

        if (!isTtsReady) {
            Log.i(TAG, "TTS not ready yet; queuing speech request: \"$text\"")
            pendingSpeechQueue.addLast(text)
            return
        }

        onSpeechStatusChanged?.invoke(true, text.toString())
        val focusGranted = requestDuckingFocus()
        if (!focusGranted) {
            Log.w(TAG, "Audio focus request rejected, proceeding to speak anyway.")
        }

        val utteranceId = UUID.randomUUID().toString()
        activeUtteranceId = utteranceId
        val params = Bundle().apply {
            putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1.0f)
        }

        val speechAttributes = getSpeechAudioAttributes()
        tts?.setAudioAttributes(speechAttributes)
        tts?.speak(text, queueMode, params, utteranceId)
    }

    /**
     * Speaks a 12-second continuous phrase allowing the driver to adjust the car volume knob in real time.
     */
    fun startContinuousCalibrationSpeech() {
        val calibrationText = "Roadtrip co-pilot audio calibration active. Adjust your car volume knob or steering wheel controls now to set your preferred listening volume. Once set, notifications will match this level."
        speakWithDucking(calibrationText)
    }

    private fun requestDuckingFocus(): Boolean {
        val targetGain = if (pauseMusicInsteadOfDuck) {
            AudioManager.AUDIOFOCUS_GAIN_TRANSIENT
        } else {
            AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK
        }

        // If focus is already held and the gain type has not changed, reuse existing focus request
        if (currentFocusRequest != null && currentFocusGain == targetGain) {
            return true
        }

        // If gain changed while holding focus, cleanly abandon the previous one before requesting anew
        if (currentFocusRequest != null) {
            abandonFocus()
        }

        val audioAttributes = getSpeechAudioAttributes()
        val focusRequest = AudioFocusRequest.Builder(targetGain)
            .setAudioAttributes(audioAttributes)
            .setAcceptsDelayedFocusGain(false)
            .setOnAudioFocusChangeListener { focusChange ->
                Log.d(TAG, "Audio focus changed: $focusChange")
                if (focusChange == AudioManager.AUDIOFOCUS_LOSS) {
                    currentFocusRequest = null
                    currentFocusGain = null
                }
            }
            .build()

        val res = audioManager.requestAudioFocus(focusRequest)
        if (res == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            currentFocusRequest = focusRequest
            currentFocusGain = targetGain
            return true
        }
        return false
    }

    private fun abandonFocus() {
        currentFocusRequest?.let { request ->
            audioManager.abandonAudioFocusRequest(request)
            currentFocusRequest = null
            currentFocusGain = null
        }
        activeUtteranceId = null
    }

    fun shutdown() {
        pendingSpeechQueue.clear()
        tts?.stop()
        tts?.shutdown()
        tts = null
        abandonFocus()
    }
}
