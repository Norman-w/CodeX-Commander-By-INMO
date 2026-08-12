package com.codexcommander.inmo

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import com.codexcommander.inmo.security.SecureTokenStore
import com.codexcommander.inmo.storage.CommanderPreferences
import com.codexcommander.inmo.storage.ConnectionEndpoint

/** Debug-build entry point used only by the local one-click ADB installer. */
class AdbProvisioningActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val endpoint = ConnectionEndpoint.normalize(intent.getStringExtra(EXTRA_ENDPOINT).orEmpty())
        val pairingCode = intent.getStringExtra(EXTRA_PAIRING_CODE)?.trim()
        if (endpoint == null || pairingCode?.matches(PAIRING_CODE) != true) {
            setResult(RESULT_CANCELED)
            finish()
            return
        }

        val preferences = CommanderPreferences(this)
        preferences.saveConnection(endpoint, pairingCode, preferences.pttMode)
        SecureTokenStore(this).clear()
        startActivity(
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
        )
        setResult(RESULT_OK)
        finish()
    }

    private companion object {
        const val EXTRA_ENDPOINT = "commander_endpoint"
        const val EXTRA_PAIRING_CODE = "commander_pairing_code"
        val PAIRING_CODE = Regex("^\\d{6}$")
    }
}
