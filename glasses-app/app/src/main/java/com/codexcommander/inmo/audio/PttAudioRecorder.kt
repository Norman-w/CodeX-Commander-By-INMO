package com.codexcommander.inmo.audio

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import com.codexcommander.inmo.protocol.AUDIO_SAMPLE_RATE
import kotlin.concurrent.thread
import kotlin.math.max

class PttAudioRecorder {
    @Volatile
    private var active = false
    private var recorder: AudioRecord? = null
    private var worker: Thread? = null

    val isActive: Boolean get() = active

    @SuppressLint("MissingPermission")
    @Synchronized
    fun start(onPcm: (ByteArray) -> Unit) {
        if (active) return
        val minimum = AudioRecord.getMinBufferSize(
            AUDIO_SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        require(minimum > 0) { "AIR3 不支持 24 kHz PCM 录音" }
        val record = AudioRecord.Builder()
            .setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(AUDIO_SAMPLE_RATE)
                    .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                    .build(),
            )
            .setBufferSizeInBytes(max(minimum * 2, FRAME_BYTES * 3))
            .setPrivacySensitive(true)
            .build()
        check(record.state == AudioRecord.STATE_INITIALIZED) { "AudioRecord 初始化失败" }

        recorder = record
        active = true
        record.startRecording()
        worker = thread(name = "commander-ptt-audio", isDaemon = true) {
            val buffer = ByteArray(FRAME_BYTES)
            try {
                while (active) {
                    val read = record.read(buffer, 0, buffer.size, AudioRecord.READ_BLOCKING)
                    if (read > 0 && active) onPcm(buffer.copyOf(read))
                    if (read == AudioRecord.ERROR_DEAD_OBJECT) break
                }
            } catch (_: IllegalStateException) {
                // stop()/release() can race a blocked OEM AudioRecord read.
            }
        }
    }

    @Synchronized
    fun stop() {
        val record = recorder ?: return
        active = false
        runCatching { record.stop() }
        worker?.join(RELEASE_DEADLINE_MS)
        worker = null
        record.release()
        recorder = null
    }

    private companion object {
        // 40 ms of mono PCM16 at 24 kHz: low PTT latency without excessive frames.
        const val FRAME_BYTES = 1_920
        const val RELEASE_DEADLINE_MS = 350L
    }
}
