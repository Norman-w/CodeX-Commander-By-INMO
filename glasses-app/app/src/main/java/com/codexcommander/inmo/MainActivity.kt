package com.codexcommander.inmo

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
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
import android.widget.Toast
import com.codexcommander.inmo.model.PttMode
import com.codexcommander.inmo.storage.CommanderPreferences
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
                hud.render(state)
                if (state.requiresScreenOn) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }

        requestAudioPermissionIfNeeded()
        if (preferences.endpoint.isBlank()) hud.post { showSetupDialog() }
    }

    override fun onResume() {
        super.onResume()
        started = true
        controller.start()
    }

    override fun onPause() {
        started = false
        controller.stop()
        super.onPause()
    }

    override fun onDestroy() {
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
                    if (now - lastApprovalClickAt <= APPROVAL_DOUBLE_CLICK_MS) {
                        lastApprovalClickAt = 0L
                        controller.onDoubleTap()
                    } else {
                        lastApprovalClickAt = now
                    }
                }
                return true
            }
            if (state.completionAwaitingReport || state.imageVisible) {
                if (event.action == KeyEvent.ACTION_UP) controller.onSingleTap()
                return true
            }
            if (event.repeatCount > 0) return true
            when (event.action) {
                KeyEvent.ACTION_DOWN -> controller.onPttDown()
                KeyEvent.ACTION_UP -> controller.onPttUp()
            }
            return true
        }
        if (event.action == KeyEvent.ACTION_UP && event.keyCode == KeyEvent.KEYCODE_MENU) {
            showSetupDialog()
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    private fun requestAudioPermissionIfNeeded() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_AUDIO)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_AUDIO && grantResults.firstOrNull() != PackageManager.PERMISSION_GRANTED) {
            Toast.makeText(this, "未授予麦克风权限，PTT 无法使用", Toast.LENGTH_LONG).show()
        }
    }

    private fun showSetupDialog(
        endpointOverride: String? = null,
        pairingOverride: String? = null,
        modeOverride: PttMode? = null,
    ) {
        if (isFinishing || isDestroyed) return
        setupDialog?.dismiss()
        val spacing = (16 * resources.displayMetrics.density).toInt()
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(spacing, spacing / 2, spacing, 0)
        }
        val endpoint = EditText(this).apply {
            hint = getString(R.string.bridge_url_hint)
            setText(endpointOverride ?: preferences.endpoint)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            minHeight = (48 * resources.displayMetrics.density).toInt()
            contentDescription = "Mac Bridge WebSocket 地址"
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
            text = "默认按住/松开。若 AIR3 实机没有可靠的抬起事件，再启用两次单击模式。"
            setPadding(0, spacing / 2, 0, spacing / 2)
        }
        layout.addView(endpoint)
        layout.addView(code)
        layout.addView(toggle)
        layout.addView(help)

        val dialog = AlertDialog.Builder(this)
            .setTitle(R.string.setup_title)
            .setView(layout)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.save, null)
            .create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val normalized = normalizeEndpoint(endpoint.text.toString())
                if (normalized == null) {
                    endpoint.error = "请输入 Tailscale Serve 的 wss:// 地址"
                    return@setOnClickListener
                }
                val enteredCode = code.text.toString().trim().takeIf(String::isNotEmpty)
                if (enteredCode != null && !enteredCode.matches(Regex("^\\d{6}$"))) {
                    code.error = "配对码必须是 6 位数字"
                    return@setOnClickListener
                }
                controller.configure(normalized, enteredCode, toggle.isChecked)
                dialog.dismiss()
            }
        }
        setupDialog = dialog
        dialog.show()
    }

    private fun normalizeEndpoint(raw: String): String? {
        val trimmed = raw.trim().trimEnd('/')
        val uri = runCatching { Uri.parse(trimmed) }.getOrNull() ?: return null
        if (uri.scheme != "wss" || uri.host.isNullOrBlank()) return null
        return if (uri.path.isNullOrBlank() || uri.path == "/") "$trimmed/v1/visor" else trimmed
    }

    private fun isPttKey(keyCode: Int): Boolean = keyCode == KeyEvent.KEYCODE_ENTER ||
        keyCode == KeyEvent.KEYCODE_DPAD_CENTER ||
        keyCode == KeyEvent.KEYCODE_HEADSETHOOK ||
        keyCode == KeyEvent.KEYCODE_BUTTON_A

    private companion object {
        const val TAG = "CodeXCommanderInput"
        const val REQUEST_AUDIO = 1001
        const val APPROVAL_DOUBLE_CLICK_MS = 420L
    }
}
