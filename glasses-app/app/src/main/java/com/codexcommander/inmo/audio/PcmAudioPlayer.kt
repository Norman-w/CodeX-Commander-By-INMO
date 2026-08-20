package com.codexcommander.inmo.audio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.util.Log
import com.codexcommander.inmo.protocol.AUDIO_SAMPLE_RATE
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.math.max
import java.util.ArrayDeque

class PcmAudioPlayer {
    private companion object {
        const val TAG = "CommanderAudio"
        const val MAX_PENDING_BYTES = AUDIO_SAMPLE_RATE * 2 * 2
    }

    private val executor: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "commander-audio-playback").apply { isDaemon = true }
    }
    private val pending = ArrayDeque<ByteArray>()
    private var pendingBytes = 0
    @Volatile
    private var track: AudioTrack? = null

    @Synchronized
    fun start() {
        releaseTrack()
        val minimum = AudioTrack.getMinBufferSize(
            AUDIO_SAMPLE_RATE,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        require(minimum > 0) { "AIR3 不支持 24 kHz PCM 播放" }
        val newTrack = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(AUDIO_SAMPLE_RATE)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build(),
            )
            .setTransferMode(AudioTrack.MODE_STREAM)
            .setBufferSizeInBytes(max(minimum * 2, 7_680))
            .build()
            .also(AudioTrack::play)
        track = newTrack
        val queued = ArrayList<ByteArray>(pending)
        pending.clear()
        pendingBytes = 0
        if (queued.isNotEmpty()) {
            executor.execute { queued.forEach { writeNow(newTrack, it) } }
        }
    }

    fun write(pcm: ByteArray) {
        if (pcm.isEmpty()) return
        val expected = synchronized(this) {
            track ?: run {
                if (pendingBytes + pcm.size <= MAX_PENDING_BYTES) {
                    val copy = pcm.copyOf()
                    pending.addLast(copy)
                    pendingBytes += copy.size
                }
                null
            }
        }
        if (expected == null) return
        executor.execute { writeNow(expected, pcm) }
    }

    @Synchronized
    fun stop() {
        pending.clear()
        pendingBytes = 0
        releaseTrack()
    }

    private fun writeNow(expected: AudioTrack, pcm: ByteArray) {
        if (track !== expected || expected.playState != AudioTrack.PLAYSTATE_PLAYING) return
        try {
            val written = expected.write(pcm, 0, pcm.size, AudioTrack.WRITE_BLOCKING)
            if (written < 0) Log.w(TAG, "AudioTrack.write returned $written for ${pcm.size} bytes")
        } catch (error: Exception) {
            Log.w(TAG, "AudioTrack.write failed", error)
        }
    }

    private fun releaseTrack() {
        val current = track ?: return
        track = null
        runCatching { current.pause() }
        runCatching { current.flush() }
        runCatching { current.stop() }
        current.release()
    }

    fun close() {
        stop()
        executor.shutdownNow()
    }
}
