package com.codexcommander.inmo.storage

import android.content.Context
import com.codexcommander.inmo.model.PttMode
import java.util.UUID

class CommanderPreferences(context: Context) {
    private val preferences = context.getSharedPreferences("commander_settings", Context.MODE_PRIVATE)

    val deviceId: String
        get() = preferences.getString(KEY_DEVICE_ID, null) ?: UUID.randomUUID().toString().also {
            preferences.edit().putString(KEY_DEVICE_ID, it).commit()
        }

    val endpoint: String get() = preferences.getString(KEY_ENDPOINT, "") ?: ""
    val pairingCode: String? get() = preferences.getString(KEY_PAIRING_CODE, null)?.takeIf(String::isNotBlank)
    val lastEventId: Long get() = preferences.getLong(KEY_LAST_EVENT_ID, 0L)
    val pttMode: PttMode
        get() = runCatching { PttMode.valueOf(preferences.getString(KEY_PTT_MODE, PttMode.HOLD.name)!!) }
            .getOrDefault(PttMode.HOLD)

    fun saveConnection(endpoint: String, pairingCode: String?, pttMode: PttMode): Boolean {
        val normalized = endpoint.trim().trimEnd('/')
        val endpointChanged = normalized != this.endpoint
        preferences.edit()
            .putString(KEY_ENDPOINT, normalized)
            .putString(KEY_PAIRING_CODE, pairingCode?.trim()?.takeIf(String::isNotBlank))
            .putString(KEY_PTT_MODE, pttMode.name)
            .apply {
                if (endpointChanged || !pairingCode.isNullOrBlank()) putLong(KEY_LAST_EVENT_ID, 0L)
            }
            .apply()
        return endpointChanged
    }

    fun clearPairingCode() {
        preferences.edit().remove(KEY_PAIRING_CODE).apply()
    }

    fun saveLastEventId(value: Long) {
        if (value > lastEventId) preferences.edit().putLong(KEY_LAST_EVENT_ID, value).apply()
    }

    private companion object {
        const val KEY_DEVICE_ID = "device_id"
        const val KEY_ENDPOINT = "endpoint"
        const val KEY_PAIRING_CODE = "pairing_code"
        const val KEY_LAST_EVENT_ID = "last_event_id"
        const val KEY_PTT_MODE = "ptt_mode"
    }
}
