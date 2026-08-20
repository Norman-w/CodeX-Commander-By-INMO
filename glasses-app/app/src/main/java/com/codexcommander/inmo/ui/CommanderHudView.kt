package com.codexcommander.inmo.ui

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.os.Handler
import android.os.Looper
import android.util.AttributeSet
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.View
import com.codexcommander.inmo.CommanderController
import com.codexcommander.inmo.model.ConnectionState
import com.codexcommander.inmo.model.HudState
import com.codexcommander.inmo.model.PttMode
import kotlin.math.abs
import kotlin.math.min

class CommanderHudView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { typeface = android.graphics.Typeface.create("sans", android.graphics.Typeface.NORMAL) }
    private val handler = Handler(Looper.getMainLooper())
    private var controller: CommanderController? = null
    private var state = HudState()
    private var holdStarted = false
    private var swiping = false
    private var suppressTapConfirmation = false
    private var firstTapApprovalRequestId: String? = null
    private var touchDownX = 0f
    private var touchDownY = 0f
    private val startHold = Runnable {
        if (
            !swiping &&
            (state.pttMode == PttMode.HOLD || state.completionAwaitingReport) &&
            state.pendingApproval == null &&
            !state.imageVisible &&
            !state.threadPickerOpen
        ) {
            if (state.completionAwaitingReport) suppressTapConfirmation = true
            controller?.onPttDown()
            holdStarted = controller?.state?.value?.listening == true
            if (holdStarted) {
                suppressTapConfirmation = true
                performHapticFeedback(android.view.HapticFeedbackConstants.VIRTUAL_KEY)
            }
        }
    }

    private val gestures = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(event: MotionEvent): Boolean = true

        override fun onSingleTapUp(event: MotionEvent): Boolean {
            state.pendingApproval?.requestId?.let { firstTapApprovalRequestId = it }
            return super.onSingleTapUp(event)
        }

        override fun onSingleTapConfirmed(event: MotionEvent): Boolean {
            if (suppressTapConfirmation) {
                suppressTapConfirmation = false
                return true
            }
            return performClick()
        }

        override fun onDoubleTap(event: MotionEvent): Boolean {
            val requestId = firstTapApprovalRequestId
            firstTapApprovalRequestId = null
            if (requestId == null || state.pendingApproval?.requestId == requestId) {
                controller?.onDoubleTap(requestId)
                performHapticFeedback(android.view.HapticFeedbackConstants.CONFIRM)
            }
            return true
        }

        override fun onFling(
            event1: MotionEvent?,
            event2: MotionEvent,
            velocityX: Float,
            velocityY: Float,
        ): Boolean {
            val start = event1 ?: return false
            val dx = event2.x - start.x
            val dy = event2.y - start.y
            if (abs(dx) < SWIPE_DISTANCE && abs(dy) < SWIPE_DISTANCE) return false
            swiping = true
            handler.removeCallbacks(startHold)
            if (abs(dy) > abs(dx)) {
                controller?.onVerticalSwipe(if (dy > 0) 1 else -1)
            } else {
                controller?.onHorizontalSwipe(if (dx < 0) 1 else -1)
            }
            performHapticFeedback(android.view.HapticFeedbackConstants.CLOCK_TICK)
            return true
        }
    })

    init {
        setBackgroundColor(Color.BLACK)
        isFocusable = true
        isFocusableInTouchMode = true
        isClickable = true
        isLongClickable = true
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    }

    fun bind(controller: CommanderController) {
        this.controller = controller
    }

    fun render(value: HudState) {
        if (state.pendingApproval?.requestId != value.pendingApproval?.requestId) {
            firstTapApprovalRequestId = null
        }
        state = value
        contentDescription = accessibilityDescription(value)
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        canvas.drawColor(Color.BLACK)
        val left = width * 0.07f
        val right = width * 0.93f
        val top = height * 0.08f
        val bottom = height * 0.92f

        drawStatus(canvas, left, right, top)
        when {
            state.pendingApproval != null -> drawApproval(canvas, left, right, top + sp(34), bottom)
            state.imageVisible -> drawImage(canvas, left, right, top + sp(32), bottom)
            state.connection != ConnectionState.CONNECTED || !state.microphoneGranted || state.setupRequired ->
                drawConnectionState(canvas, left, right, top + sp(42), bottom)
            else -> drawTask(canvas, left, right, top + sp(42), bottom)
        }
    }

    override fun performClick(): Boolean {
        super.performClick()
        controller?.onSingleTap()
        if (state.pttMode == PttMode.TOGGLE || state.imageVisible || state.completionAwaitingReport) {
            performHapticFeedback(android.view.HapticFeedbackConstants.VIRTUAL_KEY)
        }
        return true
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        gestures.onTouchEvent(event)
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                touchDownX = event.x
                touchDownY = event.y
                swiping = false
                holdStarted = false
                suppressTapConfirmation = false
                if ((state.pttMode == PttMode.HOLD || state.completionAwaitingReport) && !state.imageVisible) {
                    handler.postDelayed(startHold, HOLD_DELAY_MS)
                }
            }
            MotionEvent.ACTION_MOVE -> {
                if (abs(event.x - touchDownX) > TOUCH_SLOP || abs(event.y - touchDownY) > TOUCH_SLOP) {
                    swiping = true
                    handler.removeCallbacks(startHold)
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                handler.removeCallbacks(startHold)
                if (holdStarted) {
                    controller?.onPttUp()
                    holdStarted = false
                }
            }
        }
        return true
    }

    override fun performLongClick(): Boolean {
        super.performLongClick()
        return true
    }

    override fun onDetachedFromWindow() {
        handler.removeCallbacks(startHold)
        super.onDetachedFromWindow()
    }

    private fun drawStatus(canvas: Canvas, left: Float, right: Float, top: Float) {
        val color = when (state.connection) {
            ConnectionState.UNCONFIGURED -> COLOR_WARNING
            ConnectionState.CONNECTING -> COLOR_MUTED
            ConnectionState.CONNECTED -> COLOR_SUCCESS
            ConnectionState.DISCONNECTED -> COLOR_MUTED
            ConnectionState.ERROR -> COLOR_DANGER
        }
        paint.color = color
        paint.textSize = sp(18)
        paint.isFakeBoldText = true
        canvas.drawCircle(left + sp(5), top + sp(8), sp(5), paint)
        drawEllipsized(
            canvas,
            HudText.connectionLabel(state.connection),
            left + sp(18),
            top + sp(14),
            (right - left) * 0.42f,
        )

        paint.textAlign = Paint.Align.RIGHT
        paint.color = if (state.listening) COLOR_DANGER else COLOR_ACCENT
        val mode = when {
            state.listening && state.pttMode == PttMode.HOLD -> "正在听 · 松开提交"
            state.listening -> "正在听 · 轻触提交"
            state.playing -> "正在播报 · 按住可打断"
            !state.voiceChatActive -> "未拨号 · 先选择会话"
            state.pttMode == PttMode.HOLD -> "按住说话"
            else -> "轻触说话"
        }
        canvas.drawText(ellipsize(mode, (right - left) * 0.52f), right, top + sp(14), paint)
        paint.textAlign = Paint.Align.LEFT
        paint.isFakeBoldText = false
    }

    private fun drawConnectionState(canvas: Canvas, left: Float, right: Float, top: Float, bottom: Float) {
        val title: String
        val message: String
        val hint: String
        when {
            !state.microphoneGranted && state.connection == ConnectionState.CONNECTED -> {
                title = "需要麦克风权限"
                message = "只有你主动按住或轻触开始时才会录音。请在系统设置中允许 Codex Commander 使用麦克风。"
                hint = "权限开启前不会录音"
            }
            state.setupRequired || state.connection == ConnectionState.UNCONFIGURED -> {
                title = "先连接 Mac 上的 Codex"
                message = state.error ?: "填写 Tailscale 私网地址和 Mac 显示的一次性配对码。"
                hint = "按返回键或菜单键打开连接设置"
            }
            state.connection == ConnectionState.CONNECTING -> {
                title = "正在连接 Mac"
                message = "连接成功后，就可以按住眼镜腿说出任务。"
                hint = "请稍候"
            }
            else -> {
                title = "与 Mac 的连接中断"
                message = state.error ?: "请确认 Mac 没有休眠，Bridge 与 Tailscale 正在运行。"
                hint = state.reconnectDelaySeconds?.let { "约 $it 秒后自动重试 · 返回键可检查设置" }
                    ?: "正在自动恢复 · 返回键可检查设置"
            }
        }

        paint.color = if (state.connection == ConnectionState.ERROR || state.setupRequired) COLOR_WARNING else COLOR_WHITE
        paint.textSize = sp(25)
        paint.isFakeBoldText = true
        drawEllipsized(canvas, title, left, top, right - left)
        paint.isFakeBoldText = false

        paint.color = COLOR_WHITE
        paint.textSize = sp(20)
        drawWrapped(canvas, HudText.plain(message), left, top + sp(48), right - left, sp(29), maxLines = 5)

        paint.textSize = sp(18)
        paint.color = COLOR_MUTED
        drawEllipsized(canvas, hint, left, bottom, right - left)
    }

    private fun drawTask(canvas: Canvas, left: Float, right: Float, top: Float, bottom: Float) {
        if (state.threadPickerOpen) {
            drawThreadPicker(canvas, left, right, top, bottom)
            return
        }
        val title = state.selectedThread?.title?.let(HudText::plain)?.ifBlank { null }
            ?: if (state.threads.isEmpty()) "眼镜遥控 · 新任务" else "Codex Commander"
        paint.color = COLOR_WHITE
        paint.textSize = sp(25)
        paint.isFakeBoldText = true
        drawEllipsized(canvas, title, left, top, right - left)

        paint.isFakeBoldText = false
        paint.color = phaseColor(state.taskPhase)
        paint.textSize = sp(18)
        val selectedIndex = state.threads.indexOfFirst { it.id == state.selectedThreadId }
        val phase = if (state.threads.size > 1 && selectedIndex >= 0) {
            "任务 ${selectedIndex + 1}/${state.threads.size} · ${HudText.phaseLabel(state.taskPhase)}"
        } else {
            HudText.phaseLabel(state.taskPhase)
        }
        drawEllipsized(canvas, phase, left, top + sp(34), right - left)

        var bodyTop = top + sp(70)
        if (state.recentContext.isNotEmpty()) {
            paint.color = COLOR_MUTED
            paint.textSize = sp(16)
            canvas.drawText("上下文 · 实时", left, bodyTop, paint)
            bodyTop += sp(22)
            state.recentContext.takeLast(3).forEach { contextLine ->
                paint.color = when (contextLine.role) {
                    "user" -> COLOR_ACCENT
                    "assistant" -> COLOR_WHITE
                    "status" -> COLOR_WARNING
                    else -> COLOR_MUTED
                }
                paint.textSize = sp(18)
                drawEllipsized(canvas, HudText.plain(contextLine.text), left, bodyTop, right - left)
                bodyTop += sp(22)
            }
        }

        val body = HudText.plain(state.taskMessage)
        val lastContext = state.recentContext.lastOrNull()?.text?.let(HudText::plain)
        if (body.isNotEmpty() && !HudText.duplicatesPhase(state.taskPhase, body) && body != lastContext) {
            paint.color = COLOR_WHITE
            paint.textSize = sp(20)
            drawWrapped(canvas, body, left, bodyTop, right - left, sp(28), maxLines = 3)
        }

        val hint = when {
            state.error != null -> state.error!!
            state.completionAwaitingReport -> "轻触播放汇报 · 按住可继续说话"
            state.playing -> "正在播报 · 按住可打断并说话"
            state.activeTurnId != null -> "按住可补充指令 · 完成后才能切换任务"
            !state.voiceChatActive -> "下滑选择会话 · 上下移动 · 电脑拨号后按住说话"
            state.threads.size > 1 -> "下滑选择会话 · 上下移动 · 按住说话"
            state.pttMode == PttMode.TOGGLE -> "轻触开始说话 · 再次轻触提交"
            else -> "按住说话 · 松开提交 · 空闲时麦克风关闭"
        }
        paint.textSize = sp(18)
        paint.color = if (state.error != null) COLOR_DANGER else COLOR_MUTED
        drawEllipsized(canvas, HudText.plain(hint), left, bottom, right - left)
    }

    private fun drawThreadPicker(canvas: Canvas, left: Float, right: Float, top: Float, bottom: Float) {
        paint.color = COLOR_ACCENT
        paint.textSize = sp(24)
        paint.isFakeBoldText = true
        canvas.drawText("选择 Voice Chat 会话", left, top, paint)
        paint.isFakeBoldText = false

        val selectedIndex = if (state.threadPickerNew) state.threads.lastIndex else state.threads.indexOfFirst { it.id == state.selectedThreadId }.coerceAtLeast(0)
        val first = (selectedIndex - 2).coerceIn(0, (state.threads.size - PICKER_ROWS).coerceAtLeast(0))
        state.threads.drop(first).take(PICKER_ROWS).forEachIndexed { offset, thread ->
            val selected = thread.id == state.selectedThreadId
            val rowTop = top + sp(22) + offset * sp(54)
            if (selected) {
                paint.color = COLOR_PANEL
                canvas.drawRoundRect(RectF(left - sp(8), rowTop - sp(24), right, rowTop + sp(18)), sp(8), sp(8), paint)
            }
            paint.color = if (selected) COLOR_ACCENT else COLOR_MUTED
            paint.textSize = sp(18)
            canvas.drawText(if (selected) ">" else "·", left, rowTop, paint)
            paint.color = if (selected) COLOR_WHITE else COLOR_MUTED
            paint.textSize = sp(19)
            drawEllipsized(canvas, HudText.plain(thread.title), left + sp(18), rowTop, right - left - sp(18))
            paint.color = if (selected) COLOR_ACCENT else COLOR_MUTED
            paint.textSize = sp(14)
            drawEllipsized(canvas, HudText.threadStatusLabel(thread.status), left + sp(18), rowTop + sp(18), right - left - sp(18))
        }

        val newRowTop = top + sp(22) + PICKER_ROWS * sp(54)
        if (state.threadPickerNew) {
            paint.color = COLOR_PANEL
            canvas.drawRoundRect(RectF(left - sp(8), newRowTop - sp(24), right, newRowTop + sp(18)), sp(8), sp(8), paint)
        }
        paint.color = if (state.threadPickerNew) COLOR_ACCENT else COLOR_MUTED
        paint.textSize = sp(18)
        canvas.drawText(if (state.threadPickerNew) ">" else "+", left, newRowTop, paint)
        paint.color = if (state.threadPickerNew) COLOR_WHITE else COLOR_MUTED
        paint.textSize = sp(19)
        canvas.drawText("新建 Codex 会话", left + sp(18), newRowTop, paint)

        paint.color = COLOR_MUTED
        paint.textSize = sp(17)
        drawEllipsized(canvas, "上下移动 · 轻触选择 · 再拨打电话", left, bottom, right - left)
    }

    private fun drawApproval(canvas: Canvas, left: Float, right: Float, top: Float, bottom: Float) {
        val approval = state.pendingApproval ?: return
        paint.color = COLOR_DANGER
        paint.textSize = sp(18)
        paint.isFakeBoldText = true
        canvas.drawText("需要你确认", left, top, paint)

        paint.color = COLOR_WHITE
        paint.textSize = sp(24)
        drawEllipsized(canvas, HudText.plain(approval.title), left, top + sp(36), right - left)
        paint.isFakeBoldText = false
        paint.textSize = sp(18)
        paint.color = COLOR_MUTED
        drawWrapped(canvas, HudText.plain(approval.detail), left, top + sp(70), right - left, sp(25), maxLines = 5)

        val choiceColor = when (state.approvalChoice) {
            com.codexcommander.inmo.model.ApprovalChoice.ACCEPT -> COLOR_SUCCESS
            com.codexcommander.inmo.model.ApprovalChoice.DECLINE -> COLOR_DANGER
            com.codexcommander.inmo.model.ApprovalChoice.CANCEL -> COLOR_WARNING
        }
        paint.alpha = if (state.approvalSubmitted) 150 else 255
        paint.color = choiceColor
        paint.textSize = sp(23)
        paint.isFakeBoldText = true
        val choice = "‹  ${state.approvalChoice.label}  ›"
        canvas.drawText(choice, left, bottom - sp(38), paint)
        paint.alpha = 255
        paint.isFakeBoldText = false
        paint.color = COLOR_WHITE
        paint.textSize = sp(18)
        drawEllipsized(
            canvas,
            if (state.approvalSubmitted) "已提交，等待 Codex" else "左右滑动选择 · 双击确认 · 不能用语音批准",
            left,
            bottom,
            right - left,
        )
    }

    private fun drawImage(canvas: Canvas, left: Float, right: Float, top: Float, bottom: Float) {
        val image = state.images.getOrNull(state.imageIndex)
        if (image == null) {
            drawWrapped(canvas, "没有可显示的图片", left, top, right - left, sp(28), 2)
            return
        }
        paint.color = COLOR_WHITE
        paint.textSize = sp(20)
        paint.isFakeBoldText = true
        drawEllipsized(canvas, HudText.plain(image.title), left, top, right - left)
        paint.isFakeBoldText = false

        val imageTop = top + sp(22)
        val imageBottom = bottom - sp(30)
        val bitmap = state.imageBitmap
        val imageError = state.imageError
        if (imageError != null) {
            paint.color = COLOR_DANGER
            paint.textSize = sp(18)
            drawWrapped(canvas, imageError, left, imageTop + sp(34), right - left, sp(26), 3)
        } else if (bitmap == null) {
            paint.color = COLOR_MUTED
            paint.textSize = sp(18)
            canvas.drawText("正在载入图片…", left, imageTop + sp(34), paint)
        } else {
            drawBitmapFit(canvas, bitmap, RectF(left, imageTop, right, imageBottom))
        }

        paint.color = COLOR_MUTED
        paint.textSize = sp(18)
        val hint = if (state.images.size > 1) "${state.imageIndex + 1}/${state.images.size} · 左右滑动 · 轻触关闭" else "轻触关闭"
        canvas.drawText(hint, left, bottom, paint)
    }

    private fun drawBitmapFit(canvas: Canvas, bitmap: Bitmap, bounds: RectF) {
        val scale = min(bounds.width() / bitmap.width, bounds.height() / bitmap.height)
        val width = bitmap.width * scale
        val height = bitmap.height * scale
        val target = RectF(
            bounds.centerX() - width / 2,
            bounds.centerY() - height / 2,
            bounds.centerX() + width / 2,
            bounds.centerY() + height / 2,
        )
        paint.isFilterBitmap = true
        canvas.drawBitmap(bitmap, null, target, paint)
        paint.isFilterBitmap = false
    }

    private fun drawWrapped(
        canvas: Canvas,
        value: String,
        x: Float,
        y: Float,
        maxWidth: Float,
        lineHeight: Float,
        maxLines: Int,
    ) {
        val text = value.replace('\n', ' ').trim()
        var offset = 0
        var line = 0
        while (offset < text.length && line < maxLines) {
            var count = paint.breakText(text, offset, text.length, true, maxWidth, null)
            if (count <= 0) break
            if (offset + count < text.length && line == maxLines - 1) {
                val clipped = ellipsize(text.substring(offset).trim(), maxWidth)
                canvas.drawText(clipped, x, y + line * lineHeight, paint)
                return
            }
            while (offset + count < text.length && count > 1 && !text[offset + count].isWhitespace() && text[offset + count - 1].code < 128) count--
            val lineText = text.substring(offset, offset + count).trim()
            canvas.drawText(lineText, x, y + line * lineHeight, paint)
            offset += count
            while (offset < text.length && text[offset].isWhitespace()) offset++
            line++
        }
    }

    private fun drawEllipsized(canvas: Canvas, value: String, x: Float, y: Float, maxWidth: Float) {
        canvas.drawText(ellipsize(value, maxWidth), x, y, paint)
    }

    private fun ellipsize(value: String, maxWidth: Float): String {
        if (value.isEmpty() || paint.measureText(value) <= maxWidth) return value
        val available = (maxWidth - paint.measureText("…")).coerceAtLeast(1f)
        val count = paint.breakText(value, true, available, null).coerceAtLeast(1)
        return value.take(count).trimEnd() + "…"
    }

    private fun phaseColor(phase: String): Int = when (phase) {
        "completed" -> COLOR_SUCCESS
        "failed" -> COLOR_DANGER
        "waiting_approval" -> COLOR_WARNING
        else -> COLOR_ACCENT
    }

    private fun accessibilityDescription(value: HudState): String = buildString {
        append("Codex Commander。")
        append(HudText.connectionLabel(value.connection))
        append('。')
        when {
            value.threadPickerOpen -> append("正在选择 Voice Chat 会话。")
            value.pendingApproval != null -> append("需要审批：${value.pendingApproval.title}。当前选择${value.approvalChoice.label}。")
            else -> append(HudText.plain(value.error ?: value.taskMessage))
        }
    }

    private fun sp(value: Int): Float = android.util.TypedValue.applyDimension(
        android.util.TypedValue.COMPLEX_UNIT_SP,
        value.toFloat(),
        resources.displayMetrics,
    )

    private companion object {
        const val HOLD_DELAY_MS = 180L
        const val SWIPE_DISTANCE = 80f
        const val TOUCH_SLOP = 28f
        const val PICKER_ROWS = 4
        val COLOR_PANEL = Color.rgb(24, 43, 55)
        val COLOR_WHITE = Color.rgb(247, 251, 255)
        val COLOR_ACCENT = Color.rgb(56, 215, 255)
        val COLOR_MUTED = Color.rgb(168, 179, 189)
        val COLOR_DANGER = Color.rgb(255, 90, 103)
        val COLOR_SUCCESS = Color.rgb(72, 230, 160)
        val COLOR_WARNING = Color.rgb(255, 209, 102)
    }
}
