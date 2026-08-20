package com.codexcommander.inmo

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
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
import com.codexcommander.inmo.model.HudContextLine
import com.codexcommander.inmo.model.HudState
import com.codexcommander.inmo.network.BridgeClient
import com.codexcommander.inmo.protocol.CommanderProtocol
import com.codexcommander.inmo.protocol.ImageCard
import com.codexcommander.inmo.protocol.ServerMessage
import com.codexcommander.inmo.security.SecureTokenStore
import com.codexcommander.inmo.storage.CommanderPreferences
import com.codexcommander.inmo.ui.HudText
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
import java.security.MessageDigest

private const val MAX_CONTEXT_LINES = 6

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
    private var liveUserCaptionSeen = false
    private var liveAssistantCaptionSeen = false
    private val mutableState = MutableStateFlow(
        HudState(
            connection = if (preferences.endpoint.isBlank()) ConnectionState.UNCONFIGURED else ConnectionState.DISCONNECTED,
            pttMode = preferences.pttMode,
            microphoneGranted = applicationContext.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED,
            setupRequired = preferences.endpoint.isBlank(),
            taskMessage = if (preferences.endpoint.isBlank()) "填写 Mac 连接地址和配对码后即可开始" else "按住眼镜腿说出任务",
            lastEventId = preferences.lastEventId,
        ),
    )
    val state: StateFlow<HudState> = mutableState.asStateFlow()

    private var started = false
    private var reconnectJob: Job? = null
    private var imageJob: Job? = null
    private var reconnectAttempt = 0
    private var authenticationBlocked = false
    private var pendingReport: Pair<String, String>? = null

    fun start() {
        started = true
        setMicrophonePermission(
            applicationContext.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED,
        )
        if (preferences.endpoint.isBlank()) {
            update { it.copy(connection = ConnectionState.UNCONFIGURED, setupRequired = true) }
            return
        }
        connect()
    }

    fun stop() {
        started = false
        reconnectJob?.cancel()
        reconnectJob = null
        if (pendingReport != null) update { it.copy(completionAwaitingReport = true) }
        pendingReport = null
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
                approvalSubmitted = false,
                imageVisible = false,
                imageBitmap = null,
                imageError = null,
                reconnectDelaySeconds = null,
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
        update {
            it.copy(
                pttMode = mode,
                connection = ConnectionState.DISCONNECTED,
                setupRequired = false,
                reconnectDelaySeconds = null,
                error = null,
            )
        }
        if (started) connect()
    }

    fun setMicrophonePermission(granted: Boolean) {
        update {
            it.copy(
                microphoneGranted = granted,
                error = if (granted && it.error?.contains("麦克风权限") == true) null else it.error,
            )
        }
    }

    fun onPttDown(): PttAction = ptt.onDown().also(::applyPttAction)
    fun onPttUp(): PttAction = ptt.onUp().also(::applyPttAction)

    fun onSingleTap() {
        val current = mutableState.value
        when {
            current.threadPickerOpen -> {
                if (current.threadPickerNew) createNewVoiceTarget()
                else update { it.copy(threadPickerOpen = false, threadPickerNew = false, error = null) }
            }
            current.pendingApproval != null -> Unit
            current.imageVisible -> update { it.copy(imageVisible = false, imageBitmap = null, imageError = null) }
            current.completionAwaitingReport -> requestReport()
            current.pttMode == com.codexcommander.inmo.model.PttMode.TOGGLE && current.listening -> onPttUp()
            current.pttMode == com.codexcommander.inmo.model.PttMode.TOGGLE -> onPttDown()
        }
    }

    fun onThreadPickerTap(onNewSessionRow: Boolean) {
        val current = mutableState.value
        if (!current.threadPickerOpen) return
        if (onNewSessionRow) createNewVoiceTarget()
        else update { it.copy(threadPickerOpen = false, threadPickerNew = false, error = null) }
    }

    fun onDoubleTap(expectedApprovalRequestId: String? = null) {
        val current = mutableState.value
        val approval = current.pendingApproval
        if (approval != null) {
            if (expectedApprovalRequestId != null && approval.requestId != expectedApprovalRequestId) return
            if (current.approvalSubmitted) return
            val sent = bridge.sendControl(CommanderProtocol.approval(approval.requestId, current.approvalChoice.wireValue))
            update {
                if (sent) it.copy(approvalSubmitted = true, taskMessage = "已提交：${current.approvalChoice.label}")
                else it.copy(error = "审批未送达，请等待连接恢复后重试")
            }
            return
        }
        onSingleTap()
    }

    fun onHorizontalSwipe(direction: Int) {
        val current = mutableState.value
        if (current.pendingApproval != null) {
            if (current.approvalSubmitted) return
            val choice = approvalSelector.move(direction)
            update { it.copy(approvalChoice = choice) }
            return
        }
        if (current.imageVisible) {
            if (current.images.size > 1) {
                val next = (current.imageIndex + if (direction > 0) 1 else -1).mod(current.images.size)
                update { it.copy(imageIndex = next, imageBitmap = null, imageError = null) }
                loadImage(current.images[next])
            }
            return
        }
        if (current.threadPickerOpen) {
            if (current.voiceChatActive) {
                update { it.copy(error = "通话中不能切换目标，请先在电脑上挂断") }
                return
            }
            moveThreadSelection(if (direction > 0) 1 else -1)
            return
        }
        if (current.activeTurnId != null && current.threads.size > 1) {
            update { it.copy(error = "Codex 正在执行，完成或中断后才能切换任务") }
            return
        }
        if (current.threads.size > 1) {
            val selected = current.threads.indexOfFirst { it.id == current.selectedThreadId }.coerceAtLeast(0)
            val next = (selected + if (direction > 0) 1 else -1).mod(current.threads.size)
            val thread = current.threads[next]
            if (bridge.sendControl(CommanderProtocol.selectVoiceTarget(thread.id))) {
                update { it.copy(selectedThreadId = thread.id, taskMessage = "已切换到：${thread.title}", error = null) }
            } else {
                update { it.copy(error = "任务未切换，请等待连接恢复") }
            }
        }
    }

    fun onVerticalSwipe(direction: Int) {
        val current = mutableState.value
        if (current.pendingApproval != null || current.imageVisible) return
        if (!current.threadPickerOpen) {
            if (direction > 0 && current.threads.isNotEmpty() && !current.voiceChatActive) {
                update { it.copy(threadPickerOpen = true, threadPickerNew = false, error = null) }
            }
            return
        }
        if (current.voiceChatActive) {
            update { it.copy(error = "通话中不能切换目标，请先在电脑上挂断") }
            return
        }
        moveThreadSelection(if (direction > 0) 1 else -1)
    }

    fun interrupt() {
        bridge.sendControl(CommanderProtocol.interrupt(mutableState.value.selectedThreadId))
    }

    fun showSettingsHint() {
        update { it.copy(error = "按返回键打开连接设置") }
    }

    override fun onConnecting() = runOnMain {
        update { it.copy(connection = ConnectionState.CONNECTING, reconnectDelaySeconds = null, error = null) }
    }

    override fun onOpen() = runOnMain {
        reconnectAttempt = 0
        val token = tokenStore.read()
        val pairingCode = if (token == null) preferences.pairingCode else null
        if (token == null && pairingCode == null) {
            authenticationBlocked = true
            update {
                it.copy(
                    connection = ConnectionState.ERROR,
                    setupRequired = true,
                    error = "请输入 Mac 显示的六位配对码",
                )
            }
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
                update {
                    it.copy(
                        connection = ConnectionState.CONNECTED,
                        setupRequired = false,
                        reconnectDelaySeconds = null,
                        error = null,
                        lastEventId = message.eventId,
                    )
                }
            }
            is ServerMessage.StateSync -> {
                val current = mutableState.value
                val unreportedSummary = message.latestSummary?.takeIf { summary ->
                    message.activeTurnId == null &&
                        summaryFingerprint(summary) != preferences.reportedSummaryFingerprint(message.selectedThreadId)
                }
                val shouldNotify = unreportedSummary != null && unreportedSummary != current.latestSummary
                val selectedPreview = message.threads
                    .firstOrNull { thread -> thread.id == message.selectedThreadId }
                    ?.preview
                    ?.takeIf(String::isNotBlank)
                val syncContext = buildList {
                    selectedPreview?.let { add(HudContextLine("context", it)) }
                    unreportedSummary?.let { add(HudContextLine("assistant", it)) }
                }.takeLast(MAX_CONTEXT_LINES)
                update {
                    val phase = when {
                        message.pendingApproval != null -> "waiting_approval"
                        message.activeTurnId != null -> "working"
                        message.latestSummary != null -> "completed"
                        else -> "idle"
                    }
                    it.copy(
                        connection = ConnectionState.CONNECTED,
                        voiceChatActive = message.voiceChatActive,
                        voiceChatPhase = message.voiceChatPhase,
                        selectedThreadId = message.selectedThreadId,
                        activeTurnId = message.activeTurnId,
                        threads = message.threads,
                        threadPickerOpen = if (message.selectedThreadId != current.selectedThreadId) false else it.threadPickerOpen,
                        threadPickerNew = if (message.selectedThreadId != current.selectedThreadId) false else it.threadPickerNew,
                        recentContext = if (syncContext.isNotEmpty()) syncContext
                            else if (message.selectedThreadId != current.selectedThreadId) emptyList()
                            else it.recentContext,
                        pendingApproval = message.pendingApproval,
                        latestSummary = message.latestSummary,
                        images = message.images,
                        taskPhase = phase,
                        taskMessage = when {
                            message.pendingApproval != null -> message.pendingApproval.detail
                            message.activeTurnId != null -> "Codex 正在处理任务"
                            unreportedSummary != null -> unreportedSummary
                            message.selectedThreadId != null -> message.threads
                                .firstOrNull { thread -> thread.id == message.selectedThreadId }
                                ?.preview
                                ?.takeIf(String::isNotBlank)
                                ?: it.taskMessage
                            else -> "先在 Code X 选择会话并拨打电话"
                        },
                        completionAwaitingReport = unreportedSummary != null,
                        reconnectDelaySeconds = null,
                        error = null,
                        lastEventId = message.eventId,
                    )
                }
                if (shouldNotify) playCompletionTone()
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
                        recentContext = appendContext(it.recentContext, HudContextLine("status", message.message)),
                        latestSummary = if (completed) message.message else it.latestSummary,
                        completionAwaitingReport = completed,
                        lastEventId = message.eventId,
                        playing = if (message.phase == "failed") false else it.playing,
                        error = if (message.phase == "failed") message.message else null,
                    )
                }
                if (message.phase == "failed") player.stop()
                if (completed) playCompletionTone()
            }
            is ServerMessage.AudioStart -> {
                recorder.stop()
                ptt.forceStop()
                runCatching { player.start() }
                    .onSuccess { update { it.copy(listening = false, playing = true) } }
                    .onFailure { error ->
                        val reportFailed = pendingReport != null
                        pendingReport = null
                        update {
                            it.copy(
                                playing = false,
                                completionAwaitingReport = reportFailed || it.completionAwaitingReport,
                                error = error.message ?: "音频播放失败",
                            )
                        }
                    }
            }
            is ServerMessage.AudioEnd -> {
                player.stop()
                val completedReport = pendingReport
                pendingReport = null
                if (completedReport != null) {
                    preferences.saveReportedSummaryFingerprint(completedReport.first, completedReport.second)
                }
                update {
                    it.copy(
                        playing = false,
                        completionAwaitingReport = if (completedReport != null) false else it.completionAwaitingReport,
                        taskMessage = message.transcript?.takeIf(String::isNotBlank) ?: it.taskMessage,
                    )
                }
            }
            is ServerMessage.Caption -> {
                update {
                    it.copy(
                        taskMessage = HudText.caption(message.role, message.text),
                        recentContext = appendCaptionContext(
                            it.recentContext,
                            HudContextLine(message.role, HudText.caption(message.role, message.text)),
                        ),
                        lastEventId = message.eventId,
                    )
                }
            }
            is ServerMessage.ApprovalRequested -> {
                resetApproval()
                update { it.copy(pendingApproval = message.approval, taskPhase = "waiting_approval") }
            }
            is ServerMessage.ApprovalResolved -> {
                resetApproval()
                update {
                    it.copy(
                        pendingApproval = null,
                        approvalSubmitted = false,
                        taskMessage = HudText.approvalResolution(message.resolution),
                    )
                }
            }
            is ServerMessage.ImageReady -> {
                val images = listOf(message.image) + mutableState.value.images.filterNot { it.id == message.image.id }
                update {
                    it.copy(
                        images = images.take(20),
                        imageIndex = 0,
                        imageVisible = true,
                        imageBitmap = null,
                        imageError = null,
                    )
                }
                loadImage(message.image)
            }
            is ServerMessage.Error -> {
                if (message.code == "authentication_failed") {
                    tokenStore.clear()
                    authenticationBlocked = true
                }
                val friendly = HudText.friendlyError(message.code, message.message)
                val reportFailed = pendingReport != null
                pendingReport = null
                player.stop()
                update {
                    val leaveVoiceWait = it.taskPhase == "queued" || it.listening
                    it.copy(
                        connection = if (message.recoverable) it.connection else ConnectionState.ERROR,
                        setupRequired = message.code == "authentication_failed" || it.setupRequired,
                        listening = false,
                        playing = false,
                        taskPhase = if (leaveVoiceWait) "idle" else it.taskPhase,
                        taskMessage = if (leaveVoiceWait) "按住眼镜腿说出任务" else it.taskMessage,
                        completionAwaitingReport = reportFailed || it.completionAwaitingReport,
                        error = friendly,
                    )
                }
                recorder.stop()
                ptt.forceStop()
            }
            is ServerMessage.Pong -> Unit
        }
    }

    override fun onAudio(pcm: ByteArray) {
        runOnMain { player.write(pcm) }
    }

    override fun onClosed(reason: String) = runOnMain {
        val reportFailed = pendingReport != null
        pendingReport = null
        player.stop()
        update {
            it.copy(
                connection = ConnectionState.DISCONNECTED,
                listening = false,
                playing = false,
                completionAwaitingReport = reportFailed || it.completionAwaitingReport,
                pendingApproval = null,
                approvalSubmitted = false,
                imageVisible = false,
                imageBitmap = null,
                imageError = null,
                error = HudText.friendlyError(null, reason),
            )
        }
        recorder.stop()
        player.stop()
        ptt.forceStop()
        scheduleReconnect()
    }

    override fun onFailure(message: String) = runOnMain {
        val reportFailed = pendingReport != null
        pendingReport = null
        update {
            it.copy(
                connection = ConnectionState.ERROR,
                listening = false,
                playing = false,
                completionAwaitingReport = reportFailed || it.completionAwaitingReport,
                pendingApproval = null,
                approvalSubmitted = false,
                imageVisible = false,
                imageBitmap = null,
                imageError = null,
                error = HudText.friendlyError(null, message),
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
                update {
                    it.copy(
                        connection = ConnectionState.ERROR,
                        setupRequired = true,
                        error = HudText.friendlyError(null, error.message ?: "连接地址无效"),
                    )
                }
            }
    }

    private fun scheduleReconnect() {
        if (!started || authenticationBlocked || reconnectJob?.isActive == true) return
        val delayMs = (1_000L shl reconnectAttempt.coerceAtMost(5)).coerceAtMost(30_000L)
        reconnectAttempt++
        update { it.copy(reconnectDelaySeconds = (delayMs / 1_000L).toInt().coerceAtLeast(1)) }
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
        if (current.pendingApproval != null) {
            ptt.forceStop()
            update { it.copy(error = "请先在眼镜上处理审批") }
            return
        }
        if (!current.microphoneGranted) {
            ptt.forceStop()
            update { it.copy(error = "麦克风权限未开启，请在系统设置中允许录音") }
            return
        }
        if (current.connection != ConnectionState.CONNECTED) {
            ptt.forceStop()
            update { it.copy(error = "Mac 连接尚未就绪，请稍后再试") }
            return
        }
        if (!current.voiceChatActive) {
            ptt.forceStop()
            update { it.copy(error = "请先在 Code X 选择 Codex 会话并拨打电话") }
            return
        }
        liveUserCaptionSeen = false
        liveAssistantCaptionSeen = false
        player.stop()
        if (current.playing) {
            markPendingReportHandled()
            update { it.copy(playing = false) }
        }
        try {
            if (!bridge.sendControl(CommanderProtocol.pttStart())) throw IllegalStateException("Mac 连接已断开")
            recorder.start { pcm -> bridge.sendAudio(pcm) }
            update { it.copy(listening = true, playing = false, completionAwaitingReport = false, error = null) }
        } catch (error: Throwable) {
            recorder.stop()
            bridge.sendControl(CommanderProtocol.pttEnd())
            ptt.forceStop()
            update { it.copy(listening = false, error = HudText.friendlyError(null, error.message ?: "无法启动麦克风")) }
        }
    }

    private fun stopPtt() {
        if (!mutableState.value.listening) return
        recorder.stop()
        val sent = bridge.sendControl(CommanderProtocol.pttEnd())
        ptt.forceStop()
        update {
            if (sent) it.copy(listening = false, taskPhase = "queued", error = null)
            else it.copy(listening = false, error = "语音未送达，请等待连接恢复后重试")
        }
    }

    private fun moveThreadSelection(step: Int) {
        val current = mutableState.value
        if (current.activeTurnId != null) {
            update { it.copy(error = "Codex 正在执行，完成或中断后才能切换通话目标") }
            return
        }
        if (current.threadPickerNew) {
            if (step < 0 && current.threads.isNotEmpty()) {
                val thread = current.threads.last()
                if (bridge.sendControl(CommanderProtocol.selectVoiceTarget(thread.id))) {
                    update { it.copy(threadPickerNew = false, selectedThreadId = thread.id, taskMessage = "已选择：${thread.title}", error = null) }
                }
            }
            return
        }
        val selected = current.threads.indexOfFirst { it.id == current.selectedThreadId }.coerceAtLeast(0)
        val next = selected + step
        if (next >= current.threads.size) {
            update { it.copy(threadPickerNew = true, error = null) }
            return
        }
        if (next < 0) return
        val thread = current.threads[next]
        if (bridge.sendControl(CommanderProtocol.selectVoiceTarget(thread.id))) {
            update { it.copy(selectedThreadId = thread.id, taskMessage = "已选择：${thread.title}", error = null) }
        } else {
            update { it.copy(error = "通话目标未切换，请等待连接恢复") }
        }
    }

    private fun createNewVoiceTarget() {
        val current = mutableState.value
        if (current.voiceChatActive) {
            update { it.copy(error = "通话中不能新建目标，请先在电脑上挂断") }
            return
        }
        val sent = bridge.sendControl(CommanderProtocol.newVoiceTarget())
        update {
            if (sent) it.copy(threadPickerOpen = false, threadPickerNew = false, taskMessage = "正在新建 Codex 会话…", error = null)
            else it.copy(error = "新会话请求未送达，请等待连接恢复")
        }
    }

    private fun requestReport() {
        val current = mutableState.value
        val sent = bridge.sendControl(CommanderProtocol.reportRequest(current.selectedThreadId))
        if (sent) current.latestSummary?.let { summary ->
            current.selectedThreadId?.let { threadId ->
                pendingReport = threadId to summaryFingerprint(summary)
            }
        }
        update {
            if (sent) it.copy(completionAwaitingReport = false, taskMessage = "正在准备语音汇报…", error = null)
            else it.copy(error = "汇报请求未送达，请等待连接恢复后重试")
        }
    }

    private fun resetApproval() {
        approvalSelector.reset()
        update { it.copy(approvalChoice = ApprovalChoice.DECLINE, approvalSubmitted = false) }
    }

    private fun loadImage(image: ImageCard) {
        val token = tokenStore.read()
        if (token == null) {
            update { it.copy(imageError = "图片认证已失效，请重新配对") }
            return
        }
        imageJob?.cancel()
        imageJob = scope.launch {
            runCatching { bridge.downloadImage(image.url, preferences.deviceId, token) }
                .onSuccess { bitmap ->
                    if (mutableState.value.images.getOrNull(mutableState.value.imageIndex)?.id == image.id) {
                        update { it.copy(imageBitmap = bitmap, imageVisible = true, imageError = null) }
                    }
                }
                .onFailure { update { it.copy(imageError = "图片加载失败，请在 Mac 上检查 Bridge 日志") } }
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

    private fun appendContext(current: List<HudContextLine>, line: HudContextLine): List<HudContextLine> {
        val text = HudText.plain(line.text)
        if (text.isBlank()) return current
        val next = HudContextLine(line.role, text.take(1_200))
        val previous = current.lastOrNull()
        if (previous != null && previous.role == next.role && next.role != "status" && next.role != "context") {
            return (current.dropLast(1) + next).takeLast(MAX_CONTEXT_LINES)
        }
        return (current + next).takeLast(MAX_CONTEXT_LINES)
    }

    private fun appendCaptionContext(current: List<HudContextLine>, line: HudContextLine): List<HudContextLine> {
        val text = HudText.plain(line.text)
        if (text.isBlank()) return current
        val next = HudContextLine(line.role, text.take(1_200))
        if (line.role == "user") {
            if (!liveUserCaptionSeen) {
                liveUserCaptionSeen = true
                if (liveAssistantCaptionSeen) {
                    val assistantIndex = current.indexOfLast { it.role == "assistant" }
                    if (assistantIndex >= 0) {
                        return current.toMutableList().apply { add(assistantIndex, next) }.takeLast(MAX_CONTEXT_LINES)
                    }
                }
                return (current + next).takeLast(MAX_CONTEXT_LINES)
            }
            return replaceLastCaption(current, "user", next)
        }
        if (line.role == "assistant") {
            if (!liveAssistantCaptionSeen) {
                liveAssistantCaptionSeen = true
                return (current + next).takeLast(MAX_CONTEXT_LINES)
            }
            return replaceLastCaption(current, "assistant", next)
        }
        return appendContext(current, next)
    }

    private fun replaceLastCaption(
        current: List<HudContextLine>,
        role: String,
        next: HudContextLine,
    ): List<HudContextLine> {
        val index = current.indexOfLast { it.role == role }
        if (index < 0) return (current + next).takeLast(MAX_CONTEXT_LINES)
        return current.toMutableList().apply { set(index, next) }.takeLast(MAX_CONTEXT_LINES)
    }

    private inline fun runOnMain(crossinline block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else handler.post { block() }
    }

    private fun summaryFingerprint(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8))
        .take(12)
        .joinToString("") { byte -> "%02x".format(byte) }

    private fun markPendingReportHandled() {
        pendingReport?.let { (threadId, fingerprint) ->
            preferences.saveReportedSummaryFingerprint(threadId, fingerprint)
        }
        pendingReport = null
    }
}
