package com.codexcommander.inmo.model

import android.graphics.Bitmap
import com.codexcommander.inmo.protocol.ApprovalCard
import com.codexcommander.inmo.protocol.ImageCard
import com.codexcommander.inmo.protocol.ThreadSummary

enum class ConnectionState { UNCONFIGURED, CONNECTING, CONNECTED, DISCONNECTED, ERROR }
enum class PttMode { HOLD, TOGGLE }
enum class ApprovalChoice(val wireValue: String, val label: String) {
    DECLINE("decline", "拒绝"),
    ACCEPT("accept", "允许"),
    CANCEL("cancel", "取消"),
}

data class HudState(
    val connection: ConnectionState = ConnectionState.UNCONFIGURED,
    val pttMode: PttMode = PttMode.HOLD,
    val listening: Boolean = false,
    val playing: Boolean = false,
    val selectedThreadId: String? = null,
    val activeTurnId: String? = null,
    val threads: List<ThreadSummary> = emptyList(),
    val taskPhase: String = "idle",
    val taskMessage: String = "启动后按住眼镜腿说话",
    val latestSummary: String? = null,
    val completionAwaitingReport: Boolean = false,
    val pendingApproval: ApprovalCard? = null,
    val approvalChoice: ApprovalChoice = ApprovalChoice.DECLINE,
    val approvalArmed: Boolean = false,
    val images: List<ImageCard> = emptyList(),
    val imageIndex: Int = 0,
    val imageBitmap: Bitmap? = null,
    val imageVisible: Boolean = false,
    val lastEventId: Long = 0,
    val error: String? = null,
) {
    val selectedThread: ThreadSummary?
        get() = threads.firstOrNull { it.id == selectedThreadId }

    val requiresScreenOn: Boolean
        get() = listening || playing || pendingApproval != null || imageVisible
}

