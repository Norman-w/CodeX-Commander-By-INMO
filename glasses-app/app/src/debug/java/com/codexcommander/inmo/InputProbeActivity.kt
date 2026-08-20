package com.codexcommander.inmo

import android.app.Activity
import android.os.Bundle
import android.os.SystemClock
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.ScrollView
import android.widget.TextView
import java.util.ArrayDeque

/**
 * Debug-only screen for observing AIR3 input without assigning any action to it.
 * The Linux getevent stream is collected by scripts/air3-input-probe.sh.
 */
class InputProbeActivity : Activity() {
    private lateinit var logView: TextView
    private val eventLines = ArrayDeque<String>()
    private var lastMotionLogAt = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.decorView.systemUiVisibility =
            View.SYSTEM_UI_FLAG_FULLSCREEN or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY

        logView = TextView(this).apply {
            setTextColor(0xffd7f9ff.toInt())
            setBackgroundColor(0xff071318.toInt())
            textSize = 14f
            typeface = android.graphics.Typeface.MONOSPACE
            setPadding(28, 24, 28, 24)
            isFocusable = false
            setTextIsSelectable(true)
        }

        val scrollView = ScrollView(this).apply {
            setBackgroundColor(0xff071318.toInt())
            isFillViewport = true
            isFocusableInTouchMode = true
            addView(logView)
            requestFocus()
        }
        setContentView(scrollView)
        record("READY", "Activity probe active; no event is bound to an action")
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (::logView.isInitialized) {
            record("FOCUS", "hasFocus=$hasFocus")
        }
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        record("KEY", describeKey(event))
        return super.dispatchKeyEvent(event)
    }

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        if (shouldRecordMotion(event)) {
            record("TOUCH", describeMotion(event))
        }
        return super.dispatchTouchEvent(event)
    }

    override fun dispatchGenericMotionEvent(event: MotionEvent): Boolean {
        if (shouldRecordMotion(event)) {
            record("GENERIC", describeMotion(event))
        }
        return super.dispatchGenericMotionEvent(event)
    }

    private fun shouldRecordMotion(event: MotionEvent): Boolean {
        if (event.actionMasked != MotionEvent.ACTION_MOVE) {
            return true
        }
        val now = SystemClock.elapsedRealtime()
        if (now - lastMotionLogAt < 120L) {
            return false
        }
        lastMotionLogAt = now
        return true
    }

    private fun describeKey(event: KeyEvent): String {
        val device = InputDevice.getDevice(event.deviceId)
        return "action=${keyActionName(event.action)} " +
            "key=${KeyEvent.keyCodeToString(event.keyCode)}(${event.keyCode}) " +
            "scan=${event.scanCode} repeat=${event.repeatCount} " +
            "flags=0x${event.flags.toString(16)} meta=0x${event.metaState.toString(16)} " +
            "eventTime=${event.eventTime} downTime=${event.downTime} " +
            "deviceId=${event.deviceId} device=${device?.name ?: "unknown"} " +
            "source=0x${event.source.toString(16)}"
    }

    private fun keyActionName(action: Int): String {
        return when (action) {
            KeyEvent.ACTION_DOWN -> "ACTION_DOWN"
            KeyEvent.ACTION_UP -> "ACTION_UP"
            else -> "ACTION_$action"
        }
    }

    private fun describeMotion(event: MotionEvent): String {
        val device = InputDevice.getDevice(event.deviceId)
        return "action=${motionActionName(event.action)} " +
            "pointers=${event.pointerCount} " +
            "x=${event.x} y=${event.y} " +
            "eventTime=${event.eventTime} " +
            "deviceId=${event.deviceId} device=${device?.name ?: "unknown"} " +
            "source=0x${event.source.toString(16)}"
    }

    private fun motionActionName(action: Int): String {
        return when (action and MotionEvent.ACTION_MASK) {
            MotionEvent.ACTION_DOWN -> "ACTION_DOWN"
            MotionEvent.ACTION_UP -> "ACTION_UP"
            MotionEvent.ACTION_MOVE -> "ACTION_MOVE"
            MotionEvent.ACTION_CANCEL -> "ACTION_CANCEL"
            MotionEvent.ACTION_OUTSIDE -> "ACTION_OUTSIDE"
            MotionEvent.ACTION_POINTER_DOWN -> "ACTION_POINTER_DOWN"
            MotionEvent.ACTION_POINTER_UP -> "ACTION_POINTER_UP"
            MotionEvent.ACTION_HOVER_MOVE -> "ACTION_HOVER_MOVE"
            MotionEvent.ACTION_SCROLL -> "ACTION_SCROLL"
            else -> "ACTION_${action and MotionEvent.ACTION_MASK}"
        }
    }

    private fun record(kind: String, details: String) {
        val line = "${SystemClock.elapsedRealtime()} $kind $details"
        android.util.Log.i(TAG, line)
        if (!::logView.isInitialized) {
            return
        }
        if (eventLines.size >= MAX_LINES) {
            eventLines.removeFirst()
        }
        eventLines.addLast(line)
        logView.text = buildString {
            append("INMO AIR3 RAW INPUT PROBE\n")
            append("Observe temple actions only. No command is executed.\n\n")
            eventLines.forEach {
                append(it)
                append('\n')
            }
        }
        logView.post { (logView.parent as? ScrollView)?.fullScroll(View.FOCUS_DOWN) }
    }

    private companion object {
        const val TAG = "CodeXCommanderProbe"
        const val MAX_LINES = 100
    }
}
