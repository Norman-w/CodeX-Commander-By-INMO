package com.codexcommander.inmo.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.UUID

const val PROTOCOL_VERSION = "visor.v1"
const val AUDIO_SAMPLE_RATE = 24_000
const val AUDIO_CHANNELS = 1
const val CLIENT_AUDIO_FRAME: Byte = 0x01
const val SERVER_AUDIO_FRAME: Byte = 0x02

@Serializable
data class ThreadSummary(
    val id: String,
    val title: String,
    val preview: String = "",
    val cwd: String? = null,
    val status: String,
    val updatedAt: Long? = null,
)

@Serializable
data class ApprovalCard(
    val requestId: String,
    val kind: String,
    val title: String,
    val detail: String,
    val threadId: String,
    val turnId: String,
    val expiresAt: Long,
)

@Serializable
data class ImageCard(
    val id: String,
    val title: String,
    val url: String,
    val width: Int,
    val height: Int,
    val mimeType: String,
)

sealed interface ServerMessage {
    val eventId: Long

    data class HelloAck(
        override val eventId: Long,
        val deviceToken: String?,
        val audioSampleRate: Int,
    ) : ServerMessage

    data class StateSync(
        override val eventId: Long,
        val selectedThreadId: String?,
        val activeTurnId: String?,
        val threads: List<ThreadSummary>,
        val pendingApproval: ApprovalCard?,
        val latestSummary: String?,
        val images: List<ImageCard>,
    ) : ServerMessage

    data class TaskEvent(
        override val eventId: Long,
        val threadId: String,
        val turnId: String?,
        val phase: String,
        val message: String,
        val final: Boolean,
    ) : ServerMessage

    data class AudioStart(override val eventId: Long) : ServerMessage
    data class AudioEnd(override val eventId: Long, val transcript: String?) : ServerMessage
    data class ApprovalRequested(override val eventId: Long, val approval: ApprovalCard) : ServerMessage
    data class ApprovalResolved(override val eventId: Long, val approvalRequestId: String) : ServerMessage
    data class ImageReady(override val eventId: Long, val image: ImageCard) : ServerMessage
    data class Error(
        override val eventId: Long,
        val code: String,
        val message: String,
        val recoverable: Boolean,
    ) : ServerMessage
    data class Pong(override val eventId: Long) : ServerMessage
}

object CommanderProtocol {
    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
    }

    fun hello(
        deviceId: String,
        token: String?,
        pairingCode: String?,
        lastEventId: Long,
    ): String = json.encodeToString(
        HelloWire(
            requestId = requestId(),
            deviceId = deviceId,
            token = token,
            pairingCode = pairingCode,
            lastEventId = lastEventId,
        ),
    )

    fun stateSync(lastEventId: Long): String = json.encodeToString(
        StateSyncRequest(requestId = requestId(), lastEventId = lastEventId),
    )

    fun pttStart(): String = json.encodeToString(PttStartRequest(requestId = requestId()))
    fun pttEnd(): String = json.encodeToString(SimpleRequest(type = "ptt_end", requestId = requestId()))
    fun reportRequest(threadId: String?): String = json.encodeToString(
        OptionalThreadRequest(type = "report_request", requestId = requestId(), threadId = threadId),
    )
    fun selectTask(threadId: String): String = json.encodeToString(
        ThreadRequest(type = "task_select", requestId = requestId(), threadId = threadId),
    )
    fun interrupt(threadId: String?): String = json.encodeToString(
        OptionalThreadRequest(type = "task_interrupt", requestId = requestId(), threadId = threadId),
    )
    fun approval(approvalRequestId: String, decision: String): String = json.encodeToString(
        ApprovalRequest(
            requestId = requestId(),
            approvalRequestId = approvalRequestId,
            decision = decision,
        ),
    )

    fun parseServer(text: String): ServerMessage {
        val root = json.parseToJsonElement(text).jsonObject
        require(root["protocol"]?.jsonPrimitive?.content == PROTOCOL_VERSION) { "Unsupported protocol version" }
        val type = root["type"]?.jsonPrimitive?.content
            ?: throw IllegalArgumentException("Missing server message type")
        return when (type) {
            "hello_ack" -> json.decodeFromString<HelloAckWire>(text).let {
                ServerMessage.HelloAck(it.eventId, it.deviceToken, it.audioSampleRate)
            }
            "state_sync" -> json.decodeFromString<StateSyncWire>(text).let {
                ServerMessage.StateSync(
                    it.eventId,
                    it.selectedThreadId,
                    it.activeTurnId,
                    it.threads,
                    it.pendingApproval,
                    it.latestSummary,
                    it.images,
                )
            }
            "task_event" -> json.decodeFromString<TaskEventWire>(text).let {
                ServerMessage.TaskEvent(it.eventId, it.threadId, it.turnId, it.phase, it.message, it.final)
            }
            "assistant_audio_start" -> ServerMessage.AudioStart(eventId(text))
            "assistant_audio_end" -> json.decodeFromString<AudioEndWire>(text).let {
                ServerMessage.AudioEnd(it.eventId, it.transcript)
            }
            "approval_request" -> json.decodeFromString<ApprovalRequestWire>(text).let {
                ServerMessage.ApprovalRequested(it.eventId, it.approval)
            }
            "approval_resolved" -> json.decodeFromString<ApprovalResolvedWire>(text).let {
                ServerMessage.ApprovalResolved(it.eventId, it.approvalRequestId)
            }
            "image_card" -> json.decodeFromString<ImageReadyWire>(text).let {
                ServerMessage.ImageReady(it.eventId, it.image)
            }
            "error" -> json.decodeFromString<ErrorWire>(text).let {
                ServerMessage.Error(it.eventId, it.code, it.message, it.recoverable)
            }
            "pong" -> ServerMessage.Pong(eventId(text))
            else -> throw IllegalArgumentException("Unsupported server message: $type")
        }
    }

    fun audioFrame(pcm: ByteArray): ByteArray = ByteArray(pcm.size + 1).also { frame ->
        frame[0] = CLIENT_AUDIO_FRAME
        pcm.copyInto(frame, destinationOffset = 1)
    }

    fun decodeAudioFrame(frame: ByteArray): ByteArray {
        require(frame.size > 1 && frame[0] == SERVER_AUDIO_FRAME) { "Invalid server audio frame" }
        return frame.copyOfRange(1, frame.size)
    }

    private fun eventId(text: String): Long = json.parseToJsonElement(text)
        .jsonObject["eventId"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0L

    private fun requestId(): String = UUID.randomUUID().toString()
}

@Serializable
private data class HelloWire(
    val type: String = "hello",
    val protocol: String = PROTOCOL_VERSION,
    val requestId: String,
    val deviceId: String,
    val deviceName: String = "INMO AIR3",
    val appVersion: String = "0.1.0",
    val token: String? = null,
    val pairingCode: String? = null,
    val lastEventId: Long,
)

@Serializable
private data class StateSyncRequest(
    val type: String = "state_sync",
    val requestId: String,
    val lastEventId: Long,
)

@Serializable
private data class PttStartRequest(
    val type: String = "ptt_start",
    val requestId: String,
    val sampleRate: Int = AUDIO_SAMPLE_RATE,
    val channels: Int = AUDIO_CHANNELS,
    val encoding: String = "pcm16le",
)

@Serializable
private data class SimpleRequest(val type: String, val requestId: String)

@Serializable
private data class ThreadRequest(val type: String, val requestId: String, val threadId: String)

@Serializable
private data class OptionalThreadRequest(
    val type: String,
    val requestId: String,
    val threadId: String? = null,
)

@Serializable
private data class ApprovalRequest(
    val type: String = "approval_decision",
    val requestId: String,
    val approvalRequestId: String,
    val decision: String,
    val physicalConfirmation: Boolean = true,
)

@Serializable
private data class HelloAckWire(val eventId: Long, val deviceToken: String? = null, val audioSampleRate: Int)

@Serializable
private data class StateSyncWire(
    val eventId: Long,
    val selectedThreadId: String? = null,
    val activeTurnId: String? = null,
    val threads: List<ThreadSummary>,
    val pendingApproval: ApprovalCard? = null,
    val latestSummary: String? = null,
    val images: List<ImageCard>,
)

@Serializable
private data class TaskEventWire(
    val eventId: Long,
    val threadId: String,
    val turnId: String? = null,
    val phase: String,
    val message: String,
    val final: Boolean,
)

@Serializable
private data class AudioEndWire(val eventId: Long, val transcript: String? = null)

@Serializable
private data class ApprovalRequestWire(val eventId: Long, val approval: ApprovalCard)

@Serializable
private data class ApprovalResolvedWire(val eventId: Long, val approvalRequestId: String)

@Serializable
private data class ImageReadyWire(val eventId: Long, val image: ImageCard)

@Serializable
private data class ErrorWire(
    val eventId: Long,
    val code: String,
    val message: String,
    val recoverable: Boolean,
)
