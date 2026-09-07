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
    private val onSpeechStatusChanged: ((isSpeaking: Boolean, text: String) -> Unit)? = null
) : TextToSpeech.OnInitListener {

    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var tts: TextToSpeech? = null
    private var isTtsReady = false

    private var currentFocusRequest: AudioFocusRequest? = null

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
                Log.i(TAG, "Offline TextToSpeech initialized successfully.")
            }

            tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) {
                    Log.d(TAG, "TTS speech started: $utteranceId")
                }

                override fun onDone(utteranceId: String?) {
                    Log.d(TAG, "TTS speech completed: $utteranceId. Restoring audio focus.")
                    abandonFocus()
                    onSpeechStatusChanged?.invoke(false, "")
                }

                @Deprecated("Deprecated in Java")
                override fun onError(utteranceId: String?) {
                    Log.e(TAG, "TTS speech error on $utteranceId. Restoring audio focus.")
                    abandonFocus()
                    onSpeechStatusChanged?.invoke(false, "")
                }

                override fun onError(utteranceId: String?, errorCode: Int) {
                    Log.e(TAG, "TTS speech error code $errorCode on $utteranceId. Restoring audio focus.")
                    abandonFocus()
                    onSpeechStatusChanged?.invoke(false, "")
                }
            })
        } else {
            Log.e(TAG, "TTS initialization failed with status: $status")
        }
    }

    var pauseMusicInsteadOfDuck: Boolean = false
    var useMediaStreamChannel: Boolean = true

    /**
     * Ducks active media (like Google Maps) or pauses it, speaks the provided text through
     * the selected audio channel (Media Stream by default, or Navigation Guidance),
     * and immediately restores music volume on completion.
     */
    fun speakWithDucking(text: CharSequence) {
        if (!isTtsReady || text.isBlank()) {
            Log.w(TAG, "Cannot speak: TTS not ready or text is blank.")
            return
        }

        onSpeechStatusChanged?.invoke(true, text.toString())
        val focusGranted = requestDuckingFocus()
        if (!focusGranted) {
            Log.w(TAG, "Audio focus request rejected, proceeding to speak anyway.")
        }

        val utteranceId = UUID.randomUUID().toString()
        val params = Bundle().apply {
            putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1.0f)
            if (useMediaStreamChannel) {
                putInt(TextToSpeech.Engine.KEY_PARAM_STREAM, AudioManager.STREAM_MUSIC)
            }
        }

        val speechUsage = if (useMediaStreamChannel) {
            AudioAttributes.USAGE_MEDIA
        } else {
            AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE
        }

        val speechAttributes = AudioAttributes.Builder()
            .setUsage(speechUsage)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()

        tts?.setAudioAttributes(speechAttributes)
        tts?.speak(text, TextToSpeech.QUEUE_FLUSH, params, utteranceId)
    }

    /**
     * Speaks a 12-second continuous phrase allowing the driver to adjust the car volume knob in real time.
     */
    fun startContinuousCalibrationSpeech() {
        val calibrationText = "Roadtrip co-pilot audio calibration active. Adjust your car volume knob or steering wheel controls now to set your preferred listening volume. Once set, notifications will match this level."
        speakWithDucking(calibrationText)
    }

    private fun requestDuckingFocus(): Boolean {
        val focusUsage = if (useMediaStreamChannel) {
            AudioAttributes.USAGE_MEDIA
        } else {
            AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE
        }

        val audioAttributes = AudioAttributes.Builder()
            .setUsage(focusUsage)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()

        val gain = if (pauseMusicInsteadOfDuck) {
            AudioManager.AUDIOFOCUS_GAIN_TRANSIENT
        } else {
            AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK
        }

        val focusRequest = AudioFocusRequest.Builder(gain)
            .setAudioAttributes(audioAttributes)
            .setAcceptsDelayedFocusGain(false)
            .setOnAudioFocusChangeListener { focusChange ->
                Log.d(TAG, "Audio focus changed: $focusChange")
            }
            .build()

        currentFocusRequest = focusRequest
        val res = audioManager.requestAudioFocus(focusRequest)
        return res == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }

    private fun abandonFocus() {
        currentFocusRequest?.let { request ->
            audioManager.abandonAudioFocusRequest(request)
            currentFocusRequest = null
        }
    }

    fun shutdown() {
        tts?.stop()
        tts?.shutdown()
        tts = null
        abandonFocus()
    }
}
