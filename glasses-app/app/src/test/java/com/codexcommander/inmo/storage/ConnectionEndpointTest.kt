package com.codexcommander.inmo.storage

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ConnectionEndpointTest {
    @Test
    fun normalizesOnlyThePrivateWssBridgePath() {
        assertEquals(
            "wss://bridge.example.test/v1/visor",
            ConnectionEndpoint.normalize(" wss://bridge.example.test/ "),
        )
        assertEquals(
            "wss://bridge.example.test/v1/visor",
            ConnectionEndpoint.normalize("wss://bridge.example.test/v1/visor"),
        )
    }

    @Test
    fun rejectsCleartextCredentialsQueriesAndUnexpectedPaths() {
        assertNull(ConnectionEndpoint.normalize("ws://bridge.example.test"))
        assertNull(ConnectionEndpoint.normalize("wss://user@bridge.example.test"))
        assertNull(ConnectionEndpoint.normalize("wss://bridge.example.test/v1/other"))
        assertNull(ConnectionEndpoint.normalize("wss://bridge.example.test?v=1"))
    }
}
