package com.codexcommander.inmo.storage

import java.net.URI

object ConnectionEndpoint {
    fun normalize(raw: String): String? {
        val trimmed = raw.trim().trimEnd('/')
        val uri = runCatching { URI(trimmed) }.getOrNull() ?: return null
        if (uri.scheme != "wss" || uri.host.isNullOrBlank() || uri.userInfo != null) return null
        if (uri.path?.takeIf(String::isNotBlank)?.let { it != "/" && it != PATH } == true) return null
        if (uri.query != null || uri.fragment != null) return null
        return URI("wss", null, uri.host, uri.port, PATH, null, null).toASCIIString()
    }

    private const val PATH = "/v1/visor"
}
