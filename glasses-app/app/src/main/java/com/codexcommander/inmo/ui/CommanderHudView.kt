package com.codexcommander.inmo.ui

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
    private var touchDownX = 0f
    private var touchDownY = 0f
    private val startHold = Runnable {
        if (!swiping && state.pttMode == PttMode.HOLD && state.pendingApproval == null) {
            holdStarted = controller?.onPttDown()?.name == "START"
            if (holdStarted) performHapticFeedback(android.view.HapticFeedbackConstants.VIRTUAL_KEY)
        }
    }

    private val gestures = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(event: MotionEvent): Boolean = true

        override fun onSingleTapConfirmed(event: MotionEvent): Boolean {
            controller?.onSingleTap()
            return true
        }

        override fun onDoubleTap(event: MotionEvent): Boolean {
            controller?.onDoubleTap()
            performHapticFeedback(android.view.HapticFeedbackConstants.CONFIRM)
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
            if (abs(dx) < SWIPE_DISTANCE || abs(dx) < abs(event2.y - start.y)) return false
            swiping = true
            handler.removeCallbacks(startHold)
            controller?.onHorizontalSwipe(if (dx < 0) 1 else -1)
            performHapticFeedback(android.view.HapticFeedbackConstants.CLOCK_TICK)
            return true
        }
    })

    init {
        setBackgroundColor(Color.BLACK)
        isFocusable = true
        isFocusableInTouchMode = true
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    }

    fun bind(controller: CommanderController) {
        this.controller = controller
    }

    fun render(value: HudState) {
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
            else -> drawTask(canvas, left, right, top + sp(42), bottom)
        }
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        gestures.onTouchEvent(event)
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                touchDownX = event.x
                touchDownY = event.y
                swiping = false
                holdStarted = false
                if (state.pttMode == PttMode.HOLD) handler.postDelayed(startHold, HOLD_DELAY_MS)
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

    override fun onDetachedFromWindow() {
        handler.removeCallbacks(startHold)
        super.onDetachedFromWindow()
    }

    private fun drawStatus(canvas: Canvas, left: Float, right: Float, top: Float) {
        val (label, color) = when (state.connection) {
            ConnectionState.UNCONFIGURED -> "未配置" to COLOR_WARNING
            ConnectionState.CONNECTING -> "连接中" to COLOR_MUTED
            ConnectionState.CONNECTED -> "已连接" to COLOR_SUCCESS
            ConnectionState.DISCONNECTED -> "已断开" to COLOR_MUTED
            ConnectionState.ERROR -> "连接异常" to COLOR_DANGER
        }
        paint.color = color
        paint.textSize = sp(18)
        paint.isFakeBoldText = true
        canvas.drawCircle(left + sp(5), top + sp(8), sp(5), paint)
        canvas.drawText(label, left + sp(18), top + sp(14), paint)

        paint.textAlign = Paint.Align.RIGHT
        paint.color = if (state.listening) COLOR_DANGER else COLOR_ACCENT
        val mode = when {
            state.listening -> "正在听 · 松开提交"
            state.playing -> "语音汇报中"
            state.pttMode == PttMode.HOLD -> "按住说话"
            else -> "单击开关麦克风"
        }
        canvas.drawText(mode, right, top + sp(14), paint)
        paint.textAlign = Paint.Align.LEFT
        paint.isFakeBoldText = false
    }

    private fun drawTask(canvas: Canvas, left: Float, right: Float, top: Float, bottom: Float) {
        val title = state.selectedThread?.title ?: "CodeX Commander"
        paint.color = COLOR_WHITE
        paint.textSize = sp(25)
        paint.isFakeBoldText = true
        drawEllipsized(canvas, title, left, top, right - left)

        paint.isFakeBoldText = false
        paint.color = phaseColor(state.taskPhase)
        paint.textSize = sp(18)
        canvas.drawText(phaseLabel(state.taskPhase), left, top + sp(34), paint)

        paint.color = COLOR_WHITE
        paint.textSize = sp(20)
        val messageTop = top + sp(70)
        drawWrapped(canvas, state.taskMessage, left, messageTop, right - left, sp(28), maxLines = 6)

        val hint = when {
            state.completionAwaitingReport -> "轻触播放汇报"
            state.threads.size > 1 -> "左右滑动切换任务"
            state.error != null -> state.error!!
            else -> "非按住状态不会启用麦克风"
        }
        paint.textSize = sp(17)
        paint.color = if (state.error != null) COLOR_DANGER else COLOR_MUTED
        drawEllipsized(canvas, hint, left, bottom, right - left)
    }

    private fun drawApproval(canvas: Canvas, left: Float, right: Float, top: Float, bottom: Float) {
        val approval = state.pendingApproval ?: return
        paint.color = COLOR_DANGER
        paint.textSize = sp(18)
        paint.isFakeBoldText = true
        canvas.drawText("需要物理审批", left, top, paint)

        paint.color = COLOR_WHITE
        paint.textSize = sp(24)
        drawEllipsized(canvas, approval.title, left, top + sp(36), right - left)
        paint.isFakeBoldText = false
        paint.textSize = sp(18)
        paint.color = COLOR_MUTED
        drawWrapped(canvas, approval.detail, left, top + sp(70), right - left, sp(25), maxLines = 5)

        val choiceColor = when (state.approvalChoice) {
            com.codexcommander.inmo.model.ApprovalChoice.ACCEPT -> COLOR_SUCCESS
            com.codexcommander.inmo.model.ApprovalChoice.DECLINE -> COLOR_DANGER
            com.codexcommander.inmo.model.ApprovalChoice.CANCEL -> COLOR_WARNING
        }
        paint.alpha = if (state.approvalArmed) 150 else 255
        paint.color = choiceColor
        paint.textSize = sp(23)
        paint.isFakeBoldText = true
        val choice = "‹  ${state.approvalChoice.label}  ›"
        canvas.drawText(choice, left, bottom - sp(38), paint)
        paint.alpha = 255
        paint.isFakeBoldText = false
        paint.color = COLOR_WHITE
        paint.textSize = sp(17)
        canvas.drawText(if (state.approvalArmed) "决定已提交" else "滑动选择 · 双击确认 · 语音不可批准", left, bottom, paint)
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
        drawEllipsized(canvas, image.title, left, top, right - left)
        paint.isFakeBoldText = false

        val imageTop = top + sp(22)
        val imageBottom = bottom - sp(30)
        val bitmap = state.imageBitmap
        if (bitmap == null) {
            paint.color = COLOR_MUTED
            paint.textSize = sp(18)
            canvas.drawText("正在载入图片…", left, imageTop + sp(34), paint)
        } else {
            drawBitmapFit(canvas, bitmap, RectF(left, imageTop, right, imageBottom))
        }

        paint.color = COLOR_MUTED
        paint.textSize = sp(16)
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
                val clipped = text.substring(offset, offset + count).trimEnd() + "…"
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
        if (paint.measureText(value) <= maxWidth) {
            canvas.drawText(value, x, y, paint)
            return
        }
        var count = paint.breakText(value, true, maxWidth - paint.measureText("…"), null)
        count = count.coerceAtLeast(1)
        canvas.drawText(value.take(count).trimEnd() + "…", x, y, paint)
    }

    private fun phaseLabel(phase: String): String = when (phase) {
        "queued" -> "已排队"
        "working" -> "Codex 执行中"
        "progress" -> "Codex 正在工作"
        "waiting_approval" -> "等待审批"
        "completed" -> "已完成"
        "interrupted" -> "已中断"
        "failed" -> "执行失败"
        else -> "待命"
    }

    private fun phaseColor(phase: String): Int = when (phase) {
        "completed" -> COLOR_SUCCESS
        "failed" -> COLOR_DANGER
        "waiting_approval" -> COLOR_WARNING
        else -> COLOR_ACCENT
    }

    private fun accessibilityDescription(value: HudState): String = buildString {
        append("Codex Commander。")
        append(value.connection.name)
        append('。')
        value.pendingApproval?.let { append("需要审批：${it.title}。当前选择${value.approvalChoice.label}。") }
            ?: append(value.taskMessage)
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
        val COLOR_WHITE = Color.rgb(247, 251, 255)
        val COLOR_ACCENT = Color.rgb(56, 215, 255)
        val COLOR_MUTED = Color.rgb(168, 179, 189)
        val COLOR_DANGER = Color.rgb(255, 90, 103)
        val COLOR_SUCCESS = Color.rgb(72, 230, 160)
        val COLOR_WARNING = Color.rgb(255, 209, 102)
    }
}
