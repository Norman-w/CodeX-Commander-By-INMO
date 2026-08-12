package com.codexcommander.inmo

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.pm.PackageManager
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.InputType
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.WindowInsets
import android.view.WindowManager
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import com.codexcommander.inmo.model.PttMode
import com.codexcommander.inmo.storage.CommanderPreferences
import com.codexcommander.inmo.storage.ConnectionEndpoint
import com.codexcommander.inmo.ui.CommanderHudView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

class MainActivity : Activity() {
    private lateinit var controller: CommanderController
    private lateinit var hud: CommanderHudView
    private lateinit var preferences: CommanderPreferences
    private val uiScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var started = false
    private var setupDialog: AlertDialog? = null
    private var lastApprovalClickAt = 0L
    private var lastApprovalClickRequestId: String? = null
    private val inputHandler = Handler(Looper.getMainLooper())
    private var completionKeyGesturePending = false
    private var completionPttStarted = false
    private var completionHoldElapsed = false
    private val startCompletionPtt = Runnable {
        if (!completionKeyGesturePending || controller.state.value.pendingApproval != null) return@Runnable
        completionHoldElapsed = true
        controller.onPttDown()
        completionPttStarted = controller.state.value.listening
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setBackgroundDrawableResource(android.R.color.black)
        window.statusBarColor = Color.BLACK
        window.navigationBarColor = Color.BLACK
        window.setDecorFitsSystemWindows(false)
        window.insetsController?.hide(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
        window.insetsController?.systemBarsBehavior = android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE

        preferences = CommanderPreferences(this)
        controller = CommanderController(this)
        hud = CommanderHudView(this).also {
            it.bind(controller)
            setContentView(it)
        }
        uiScope.launch {
            controller.state.collectLatest { state ->
                val approvalRequestId = state.pendingApproval?.requestId
                if (approvalRequestId != lastApprovalClickRequestId && lastApprovalClickAt != 0L) {
                    lastApprovalClickAt = 0L
                    lastApprovalClickRequestId = null
                }
                hud.render(state)
                if (state.requiresScreenOn) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                if (state.setupRequired && setupDialog?.isShowing != true) {
                    hud.post { showSetupDialog() }
                }
            }
        }

        if (preferences.endpoint.isBlank()) {
            hud.post { showSetupDialog() }
        } else {
            requestAudioPermissionIfNeeded()
        }
    }

    override fun onResume() {
        super.onResume()
        controller.setMicrophonePermission(hasAudioPermission())
        started = true
        controller.start()
    }

    override fun onPause() {
        cancelCompletionKeyGesture()
        started = false
        controller.stop()
        super.onPause()
    }

    override fun onDestroy() {
        cancelCompletionKeyGesture()
        setupDialog?.dismiss()
        controller.close()
        uiScope.cancel()
        super.onDestroy()
    }

    @Deprecated("Android back dispatcher is not required for this single-Activity HUD")
    override fun onBackPressed() {
        showSetupDialog()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (BuildConfig.DEBUG && event.repeatCount == 0) {
            Log.i(TAG, "AIR3 input probe action=${event.action} keyCode=${event.keyCode} scanCode=${event.scanCode}")
        }
        if (event.action == KeyEvent.ACTION_UP && (event.keyCode == KeyEvent.KEYCODE_DPAD_LEFT || event.keyCode == KeyEvent.KEYCODE_DPAD_RIGHT)) {
            controller.onHorizontalSwipe(if (event.keyCode == KeyEvent.KEYCODE_DPAD_RIGHT) 1 else -1)
            return true
        }
        if (isPttKey(event.keyCode)) {
            val state = controller.state.value
            if (state.pendingApproval != null) {
                if (event.action == KeyEvent.ACTION_UP) {
                    val now = android.os.SystemClock.elapsedRealtime()
                    if (
                        state.pendingApproval.requestId == lastApprovalClickRequestId &&
                        now - lastApprovalClickAt <= APPROVAL_DOUBLE_CLICK_MS
                    ) {
                        lastApprovalClickAt = 0L
                        lastApprovalClickRequestId = null
                        controller.onDoubleTap(state.pendingApproval.requestId)
                    } else {
                        lastApprovalClickAt = now
                        lastApprovalClickRequestId = state.pendingApproval.requestId
                        hud.performHapticFeedback(android.view.HapticFeedbackConstants.CLOCK_TICK)
                    }
                }
                return true
            }
            if (state.imageVisible) {
                if (event.action == KeyEvent.ACTION_UP) controller.onSingleTap()
                return true
            }
            if (state.completionAwaitingReport) {
                handleCompletionKeyGesture(event)
                return true
            }
            if (event.repeatCount > 0) return true
            when (event.action) {
                KeyEvent.ACTION_DOWN -> controller.onPttDown()
                KeyEvent.ACTION_UP -> controller.onPttUp()
            }
            return true
        }
        if (
            event.action == KeyEvent.ACTION_UP &&
            event.keyCode == KeyEvent.KEYCODE_SPACE &&
            controller.state.value.completionAwaitingReport
        ) {
            controller.onSingleTap()
            return true
        }
        if (event.action == KeyEvent.ACTION_UP && event.keyCode == KeyEvent.KEYCODE_MENU) {
            showSetupDialog()
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    private fun requestAudioPermissionIfNeeded() {
        if (!hasAudioPermission()) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_AUDIO)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_AUDIO) {
            val granted = grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
            controller.setMicrophonePermission(granted)
            if (!granted) showMicrophonePermissionDialog()
        }
    }

    private fun showSetupDialog(
        endpointOverride: String? = null,
        pairingOverride: String? = null,
        modeOverride: PttMode? = null,
    ) {
        if (isFinishing || isDestroyed) return
        setupDialog?.let { existing ->
            if (existing.isShowing && endpointOverride == null && pairingOverride == null && modeOverride == null) return
            existing.dismiss()
        }
        val spacing = (16 * resources.displayMetrics.density).toInt()
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(spacing, spacing / 2, spacing, 0)
        }
        val endpointLabel = TextView(this).apply {
            text = getString(R.string.bridge_url_label)
            setTextColor(Color.WHITE)
            textSize = 18f
            setPadding(0, spacing / 2, 0, spacing / 4)
        }
        val endpoint = EditText(this).apply {
            hint = getString(R.string.bridge_url_hint)
            setText(endpointOverride ?: preferences.endpoint)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            minHeight = (48 * resources.displayMetrics.density).toInt()
            contentDescription = "Tailscale 私网连接地址"
        }
        val codeLabel = TextView(this).apply {
            text = getString(R.string.pairing_code_label)
            setTextColor(Color.WHITE)
            textSize = 18f
            setPadding(0, spacing / 2, 0, spacing / 4)
        }
        val code = EditText(this).apply {
            hint = getString(R.string.pairing_code_hint)
            setText(pairingOverride.orEmpty())
            inputType = InputType.TYPE_CLASS_NUMBER
            maxLines = 1
            minHeight = (48 * resources.displayMetrics.density).toInt()
            contentDescription = "六位配对码"
        }
        val toggle = CheckBox(this).apply {
            text = getString(R.string.toggle_mode)
            isChecked = (modeOverride ?: preferences.pttMode) == PttMode.TOGGLE
            minHeight = (48 * resources.displayMetrics.density).toInt()
        }
        val help = TextView(this).apply {
            text = "默认按住说话、松开提交；空闲时不会开启麦克风。地址和配对码都只保存在眼镜应用私有存储中。"
            setTextColor(Color.LTGRAY)
            textSize = 18f
            setPadding(0, spacing / 2, 0, spacing / 2)
        }
        layout.addView(endpointLabel)
        layout.addView(endpoint)
        layout.addView(codeLabel)
        layout.addView(code)
        layout.addView(toggle)
        layout.addView(help)

        val firstSetup = preferences.endpoint.isBlank()
        val builder = AlertDialog.Builder(this)
            .setTitle(R.string.setup_title)
            .setView(layout)
            .setPositiveButton(R.string.save, null)
        if (!firstSetup) builder.setNegativeButton(R.string.cancel, null)
        val dialog = builder.create()
        dialog.setCanceledOnTouchOutside(!firstSetup)
        dialog.setCancelable(!firstSetup)
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val normalized = ConnectionEndpoint.normalize(endpoint.text.toString())
                if (normalized == null) {
                    endpoint.error = "请输入 Tailscale Serve 的 wss:// 地址"
                    return@setOnClickListener
                }
                val enteredCode = code.text.toString().trim().takeIf(String::isNotEmpty)
                if (enteredCode == null && controller.state.value.setupRequired) {
                    code.error = "请输入 Mac 显示的 6 位配对码"
                    return@setOnClickListener
                }
                if (enteredCode != null && !enteredCode.matches(Regex("^\\d{6}$"))) {
                    code.error = "配对码必须是 6 位数字"
                    return@setOnClickListener
                }
                controller.configure(normalized, enteredCode, toggle.isChecked)
                dialog.dismiss()
                requestAudioPermissionIfNeeded()
            }
            endpoint.requestFocus()
        }
        setupDialog = dialog
        dialog.setOnDismissListener {
            if (setupDialog === dialog) setupDialog = null
        }
        dialog.show()
    }

    private fun showMicrophonePermissionDialog() {
        if (isFinishing || isDestroyed) return
        AlertDialog.Builder(this)
            .setTitle("允许按住说话")
            .setMessage("Codex Commander 只会在你主动按住或轻触开始时录音；松开或提交后立即释放麦克风。")
            .setPositiveButton(R.string.open_settings) { _, _ ->
                startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                        data = Uri.fromParts("package", packageName, null)
                    },
                )
            }
            .setNegativeButton(R.string.not_now, null)
            .show()
    }

    private fun hasAudioPermission(): Boolean =
        checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun handleCompletionKeyGesture(event: KeyEvent) {
        when (event.action) {
            KeyEvent.ACTION_DOWN -> if (event.repeatCount == 0) {
                completionKeyGesturePending = true
                completionPttStarted = false
                completionHoldElapsed = false
                inputHandler.postDelayed(startCompletionPtt, COMPLETION_HOLD_DELAY_MS)
            }
            KeyEvent.ACTION_UP -> {
                inputHandler.removeCallbacks(startCompletionPtt)
                if (!completionKeyGesturePending) return
                completionKeyGesturePending = false
                if (completionPttStarted) controller.onPttUp()
                else if (!completionHoldElapsed) controller.onSingleTap()
                completionPttStarted = false
                completionHoldElapsed = false
            }
        }
    }

    private fun cancelCompletionKeyGesture() {
        inputHandler.removeCallbacks(startCompletionPtt)
        if (completionPttStarted) controller.onPttUp()
        completionKeyGesturePending = false
        completionPttStarted = false
        completionHoldElapsed = false
    }

    private fun isPttKey(keyCode: Int): Boolean = keyCode == KeyEvent.KEYCODE_ENTER ||
        keyCode == KeyEvent.KEYCODE_DPAD_CENTER ||
        keyCode == KeyEvent.KEYCODE_HEADSETHOOK ||
        keyCode == KeyEvent.KEYCODE_BUTTON_A

    private companion object {
        const val TAG = "CodeXCommanderInput"
        const val REQUEST_AUDIO = 1001
        const val APPROVAL_DOUBLE_CLICK_MS = 420L
        const val COMPLETION_HOLD_DELAY_MS = 180L
    }
}
