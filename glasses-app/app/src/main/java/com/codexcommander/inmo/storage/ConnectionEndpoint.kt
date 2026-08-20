package com.codexcommander.inmo.storage

import com.codexcommander.inmo.BuildConfig
import java.net.URI

object ConnectionEndpoint {
    private const val PATH = "/v1/visor"

    fun normalize(raw: String): String? {
        val trimmed = raw.trim().trimEnd('/')
        val uri = runCatching { URI(trimmed) }.getOrNull() ?: return null
        if (uri.scheme !in allowedSchemes() || uri.host.isNullOrBlank() || uri.userInfo != null) return null
        if (uri.path?.takeIf(String::isNotBlank)?.let { it != "/" && it != PATH } == true) return null
        if (uri.query != null || uri.fragment != null) return null
        return URI(uri.scheme, null, uri.host, uri.port, PATH, null, null).toASCIIString()
    }

    private fun allowedSchemes(): Set<String> =
        if (BuildConfig.DEBUG) setOf("ws", "wss") else setOf("wss")
}
