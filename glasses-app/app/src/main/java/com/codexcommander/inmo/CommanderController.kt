package com.codexcommander.inmo

import android.content.Context
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Handler
import android.os.Looper
import com.codexcommander.inmo.audio.PcmAudioPlayer
import com.codexcommander.inmo.audio.PttAudioRecorder
import com.codexcommander.inmo.input.ApprovalSelector
import com.codexcommander.inmo.input.PttAction
import com.codexcommander.inmo.input.PttStateMachine
import com.codexcommander.inmo.model.ApprovalChoice
import com.codexcommander.inmo.model.ConnectionState
import com.codexcommander.inmo.model.HudState
import com.codexcommander.inmo.network.BridgeClient
import com.codexcommander.inmo.protocol.CommanderProtocol
import com.codexcommander.inmo.protocol.ImageCard
import com.codexcommander.inmo.protocol.ServerMessage
import com.codexcommander.inmo.security.SecureTokenStore
import com.codexcommander.inmo.storage.CommanderPreferences
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class CommanderController(context: Context) : BridgeClient.Listener {
    private val applicationContext = context.applicationContext
    private val preferences = CommanderPreferences(applicationContext)
    private val tokenStore = SecureTokenStore(applicationContext)
    private val bridge = BridgeClient(this)
    private val recorder = PttAudioRecorder()
    private val player = PcmAudioPlayer()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val handler = Handler(Looper.getMainLooper())
    private val ptt = PttStateMachine(preferences.pttMode)
    private val approvalSelector = ApprovalSelector()
    private val mutableState = MutableStateFlow(
        HudState(
            connection = if (preferences.endpoint.isBlank()) ConnectionState.UNCONFIGURED else ConnectionState.DISCONNECTED,
            pttMode = preferences.pttMode,
            lastEventId = preferences.lastEventId,
        ),
    )
    val state: StateFlow<HudState> = mutableState.asStateFlow()

    private var started = false
    private var reconnectJob: Job? = null
    private var imageJob: Job? = null
    private var reconnectAttempt = 0
    private var authenticationBlocked = false

    fun start() {
        started = true
        if (preferences.endpoint.isBlank()) {
            update { it.copy(connection = ConnectionState.UNCONFIGURED) }
            return
        }
        connect()
    }

    fun stop() {
        started = false
        reconnectJob?.cancel()
        reconnectJob = null
        ptt.forceStop()
        recorder.stop()
        player.stop()
        bridge.disconnect()
        update {
            it.copy(
                listening = false,
                playing = false,
                connection = ConnectionState.DISCONNECTED,
                pendingApproval = null,
                approvalArmed = false,
                imageVisible = false,
                imageBitmap = null,
            )
        }
    }

    fun close() {
        stop()
        imageJob?.cancel()
        bridge.close()
        player.close()
        scope.cancel()
    }

    fun configure(endpoint: String, pairingCode: String?, toggleMode: Boolean) {
        val mode = if (toggleMode) com.codexcommander.inmo.model.PttMode.TOGGLE else com.codexcommander.inmo.model.PttMode.HOLD
        val endpointChanged = preferences.saveConnection(endpoint, pairingCode, mode)
        if (endpointChanged || !pairingCode.isNullOrBlank()) tokenStore.clear()
        ptt.mode = mode
        authenticationBlocked = false
        update { it.copy(pttMode = mode, connection = ConnectionState.DISCONNECTED, error = null) }
        if (started) connect()
    }

    fun onPttDown(): PttAction = ptt.onDown().also(::applyPttAction)
    fun onPttUp(): PttAction = ptt.onUp().also(::applyPttAction)

    fun onSingleTap() {
        val current = mutableState.value
        when {
            current.pendingApproval != null -> Unit
            current.imageVisible -> update { it.copy(imageVisible = false, imageBitmap = null) }
            current.completionAwaitingReport -> requestReport()
            current.pttMode == com.codexcommander.inmo.model.PttMode.TOGGLE -> onPttDown()
        }
    }

    fun onDoubleTap() {
        val current = mutableState.value
        val approval = current.pendingApproval
        if (approval != null) {
            if (current.approvalArmed) return
            val sent = bridge.sendControl(CommanderProtocol.approval(approval.requestId, current.approvalChoice.wireValue))
            update {
                if (sent) it.copy(approvalArmed = true, taskMessage = "已提交${current.approvalChoice.label}决定")
                else it.copy(error = "审批发送失败，Bridge 已断开")
            }
            return
        }
        onSingleTap()
    }

    fun onHorizontalSwipe(direction: Int) {
        val current = mutableState.value
        if (current.pendingApproval != null) {
            val choice = approvalSelector.move(direction)
            update { it.copy(approvalChoice = choice, approvalArmed = false) }
            return
        }
        if (current.imageVisible && current.images.size > 1) {
            val next = (current.imageIndex + if (direction > 0) 1 else -1).mod(current.images.size)
            update { it.copy(imageIndex = next, imageBitmap = null) }
            loadImage(current.images[next])
            return
        }
        if (current.threads.isNotEmpty()) {
            val selected = current.threads.indexOfFirst { it.id == current.selectedThreadId }.coerceAtLeast(0)
            val next = (selected + if (direction > 0) 1 else -1).mod(current.threads.size)
            val thread = current.threads[next]
            bridge.sendControl(CommanderProtocol.selectTask(thread.id))
            update { it.copy(selectedThreadId = thread.id, taskMessage = "已选择：${thread.title}") }
        }
    }

    fun interrupt() {
        bridge.sendControl(CommanderProtocol.interrupt(mutableState.value.selectedThreadId))
    }

    fun showSettingsHint() {
        update { it.copy(error = "按返回键打开连接设置") }
    }

    override fun onConnecting() = runOnMain {
        update { it.copy(connection = ConnectionState.CONNECTING, error = null) }
    }

    override fun onOpen() = runOnMain {
        reconnectAttempt = 0
        val token = tokenStore.read()
        val pairingCode = if (token == null) preferences.pairingCode else null
        if (token == null && pairingCode == null) {
            update { it.copy(connection = ConnectionState.ERROR, error = "缺少设备令牌，请输入 Mac 显示的配对码") }
            bridge.disconnect()
            return@runOnMain
        }
        bridge.sendControl(
            CommanderProtocol.hello(
                deviceId = preferences.deviceId,
                token = token,
                pairingCode = pairingCode,
                lastEventId = preferences.lastEventId,
            ),
        )
    }

    override fun onMessage(message: ServerMessage) = runOnMain {
        if (message.eventId > preferences.lastEventId) preferences.saveLastEventId(message.eventId)
        when (message) {
            is ServerMessage.HelloAck -> {
                authenticationBlocked = false
                message.deviceToken?.let {
                    tokenStore.save(it)
                    preferences.clearPairingCode()
                }
                update { it.copy(connection = ConnectionState.CONNECTED, error = null, lastEventId = message.eventId) }
            }
            is ServerMessage.StateSync -> {
                val hadSummary = mutableState.value.latestSummary
                update {
                    val newSummary = message.latestSummary?.takeIf { summary ->
                        message.activeTurnId == null && summary != it.latestSummary
                    }
                    val phase = when {
                        message.pendingApproval != null -> "waiting_approval"
                        message.activeTurnId != null -> "working"
                        message.latestSummary != null -> "completed"
                        else -> "idle"
                    }
                    it.copy(
                        connection = ConnectionState.CONNECTED,
                        selectedThreadId = message.selectedThreadId,
                        activeTurnId = message.activeTurnId,
                        threads = message.threads,
                        pendingApproval = message.pendingApproval,
                        latestSummary = message.latestSummary,
                        images = message.images,
                        taskPhase = phase,
                        taskMessage = when {
                            message.pendingApproval != null -> message.pendingApproval.detail
                            message.activeTurnId != null -> "Codex 正在执行，已同步最新状态"
                            newSummary != null -> newSummary
                            else -> it.taskMessage
                        },
                        completionAwaitingReport = newSummary != null,
                        lastEventId = message.eventId,
                    )
                }
                if (message.activeTurnId == null && message.latestSummary != null && message.latestSummary != hadSummary) playCompletionTone()
                if (message.pendingApproval != null) resetApproval()
            }
            is ServerMessage.TaskEvent -> {
                val completed = message.final && message.phase == "completed"
                update {
                    it.copy(
                        selectedThreadId = message.threadId,
                        activeTurnId = if (message.final) null else message.turnId,
                        taskPhase = message.phase,
                        taskMessage = message.message,
                        latestSummary = if (completed) message.message else it.latestSummary,
                        completionAwaitingReport = completed,
                        lastEventId = message.eventId,
                        error = if (message.phase == "failed") message.message else null,
                    )
                }
                if (completed) playCompletionTone()
            }
            is ServerMessage.AudioStart -> {
                recorder.stop()
                ptt.forceStop()
                runCatching { player.start() }
                    .onSuccess { update { it.copy(listening = false, playing = true) } }
                    .onFailure { error -> update { it.copy(playing = false, error = error.message ?: "音频播放失败") } }
            }
            is ServerMessage.AudioEnd -> {
                player.stop()
                update {
                    it.copy(
                        playing = false,
                        taskMessage = message.transcript?.takeIf(String::isNotBlank) ?: it.taskMessage,
                    )
                }
            }
            is ServerMessage.ApprovalRequested -> {
                resetApproval()
                update { it.copy(pendingApproval = message.approval, taskPhase = "waiting_approval") }
            }
            is ServerMessage.ApprovalResolved -> {
                resetApproval()
                update { it.copy(pendingApproval = null, approvalArmed = false, taskMessage = "审批已处理") }
            }
            is ServerMessage.ImageReady -> {
                val images = listOf(message.image) + mutableState.value.images.filterNot { it.id == message.image.id }
                update { it.copy(images = images.take(20), imageIndex = 0, imageVisible = true, imageBitmap = null) }
                loadImage(message.image)
            }
            is ServerMessage.Error -> {
                if (message.code == "authentication_failed") {
                    tokenStore.clear()
                    authenticationBlocked = true
                }
                update {
                    it.copy(
                        connection = if (message.recoverable) it.connection else ConnectionState.ERROR,
                        listening = false,
                        error = message.message,
                    )
                }
                recorder.stop()
                ptt.forceStop()
            }
            is ServerMessage.Pong -> Unit
        }
    }

    override fun onAudio(pcm: ByteArray) {
        player.write(pcm)
    }

    override fun onClosed(reason: String) = runOnMain {
        update {
            it.copy(
                connection = ConnectionState.DISCONNECTED,
                listening = false,
                playing = false,
                pendingApproval = null,
                approvalArmed = false,
                imageVisible = false,
                imageBitmap = null,
                error = reason,
            )
        }
        recorder.stop()
        player.stop()
        ptt.forceStop()
        scheduleReconnect()
    }

    override fun onFailure(message: String) = runOnMain {
        update {
            it.copy(
                connection = ConnectionState.ERROR,
                listening = false,
                playing = false,
                pendingApproval = null,
                approvalArmed = false,
                imageVisible = false,
                imageBitmap = null,
                error = message,
            )
        }
        recorder.stop()
        player.stop()
        ptt.forceStop()
        scheduleReconnect()
    }

    private fun connect() {
        reconnectJob?.cancel()
        reconnectJob = null
        runCatching { bridge.connect(preferences.endpoint) }
            .onFailure { error ->
                update { it.copy(connection = ConnectionState.ERROR, error = error.message ?: "Bridge 地址无效") }
            }
    }

    private fun scheduleReconnect() {
        if (!started || authenticationBlocked || reconnectJob?.isActive == true) return
        val delayMs = (1_000L shl reconnectAttempt.coerceAtMost(5)).coerceAtMost(30_000L)
        reconnectAttempt++
        reconnectJob = scope.launch {
            delay(delayMs)
            if (started) connect()
        }
    }

    private fun applyPttAction(action: PttAction) {
        when (action) {
            PttAction.NONE -> Unit
            PttAction.START -> startPtt()
            PttAction.STOP -> stopPtt()
        }
    }

    private fun startPtt() {
        val current = mutableState.value
        if (current.connection != ConnectionState.CONNECTED || current.pendingApproval != null) {
            ptt.forceStop()
            update { it.copy(error = if (current.pendingApproval != null) "请先物理处理审批卡" else "Bridge 尚未连接") }
            return
        }
        player.stop()
        if (current.playing) update { it.copy(playing = false) }
        try {
            if (!bridge.sendControl(CommanderProtocol.pttStart())) throw IllegalStateException("Bridge 连接已断开")
            recorder.start { pcm -> bridge.sendAudio(pcm) }
            update { it.copy(listening = true, playing = false, completionAwaitingReport = false, error = null) }
        } catch (error: Throwable) {
            recorder.stop()
            bridge.sendControl(CommanderProtocol.pttEnd())
            ptt.forceStop()
            update { it.copy(listening = false, error = error.message ?: "无法启动麦克风") }
        }
    }

    private fun stopPtt() {
        if (!mutableState.value.listening) return
        recorder.stop()
        val sent = bridge.sendControl(CommanderProtocol.pttEnd())
        ptt.forceStop()
        update {
            if (sent) it.copy(listening = false, taskMessage = "正在理解并交给 Codex…")
            else it.copy(listening = false, error = "语音提交失败，Bridge 已断开")
        }
    }

    private fun requestReport() {
        bridge.sendControl(CommanderProtocol.reportRequest(mutableState.value.selectedThreadId))
        update { it.copy(completionAwaitingReport = false, taskMessage = "正在准备语音汇报…") }
    }

    private fun resetApproval() {
        approvalSelector.reset()
        update { it.copy(approvalChoice = ApprovalChoice.DECLINE, approvalArmed = false) }
    }

    private fun loadImage(image: ImageCard) {
        val token = tokenStore.read() ?: return
        imageJob?.cancel()
        imageJob = scope.launch {
            runCatching { bridge.downloadImage(image.url, preferences.deviceId, token) }
                .onSuccess { bitmap ->
                    if (mutableState.value.images.getOrNull(mutableState.value.imageIndex)?.id == image.id) {
                        update { it.copy(imageBitmap = bitmap, imageVisible = true, error = null) }
                    }
                }
                .onFailure { error -> update { it.copy(error = error.message ?: "图片加载失败") } }
        }
    }

    private fun playCompletionTone() {
        runCatching {
            val tone = ToneGenerator(AudioManager.STREAM_NOTIFICATION, 55)
            tone.startTone(ToneGenerator.TONE_PROP_ACK, 140)
            handler.postDelayed({ tone.release() }, 300)
        }
    }

    private fun update(transform: (HudState) -> HudState) {
        mutableState.value = transform(mutableState.value)
    }

    private inline fun runOnMain(crossinline block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else handler.post { block() }
    }
}
