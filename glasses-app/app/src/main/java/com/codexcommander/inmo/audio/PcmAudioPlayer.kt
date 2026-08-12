package com.codexcommander.inmo.audio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import com.codexcommander.inmo.protocol.AUDIO_SAMPLE_RATE
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.math.max

class PcmAudioPlayer {
    private val executor: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "commander-audio-playback").apply { isDaemon = true }
    }
    @Volatile
    private var track: AudioTrack? = null

    @Synchronized
    fun start() {
        stop()
        val minimum = AudioTrack.getMinBufferSize(
            AUDIO_SAMPLE_RATE,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        require(minimum > 0) { "AIR3 不支持 24 kHz PCM 播放" }
        track = AudioTrack.Builder()
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
    }

    fun write(pcm: ByteArray) {
        val expected = track ?: return
        executor.execute {
            if (track === expected && expected.playState == AudioTrack.PLAYSTATE_PLAYING) {
                runCatching { expected.write(pcm, 0, pcm.size, AudioTrack.WRITE_BLOCKING) }
            }
        }
    }

    @Synchronized
    fun stop() {
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
