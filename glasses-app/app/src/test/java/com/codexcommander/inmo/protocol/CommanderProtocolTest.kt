package com.codexcommander.inmo.protocol

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CommanderProtocolTest {
    @Test
    fun encodesPttAudioWithKindByte() {
        val frame = CommanderProtocol.audioFrame(byteArrayOf(1, 2, 3))
        assertArrayEquals(byteArrayOf(CLIENT_AUDIO_FRAME, 1, 2, 3), frame)
    }

    @Test
    fun parsesTaskEventAndIgnoresFutureFields() {
        val parsed = CommanderProtocol.parseServer(
            """{"type":"task_event","protocol":"visor.v1","eventId":9,"sentAt":1,"threadId":"t","turnId":"u","phase":"working","message":"ok","final":false,"future":true}""",
        ) as ServerMessage.TaskEvent
        assertEquals(9L, parsed.eventId)
        assertEquals("ok", parsed.message)
    }

    @Test
    fun helloContainsExactlyOneProvidedCredential() {
        val value = CommanderProtocol.hello("device-123456", null, "123456", 0)
        assertTrue(value.contains("\"pairingCode\":\"123456\""))
        assertTrue(!value.contains("\"token\""))
    }

    @Test
    fun parsesApprovalResolutionReason() {
        val parsed = CommanderProtocol.parseServer(
            """{"type":"approval_resolved","protocol":"visor.v1","eventId":10,"sentAt":1,"approvalRequestId":"approval-1","resolution":"expired"}""",
        ) as ServerMessage.ApprovalResolved

        assertEquals("expired", parsed.resolution)
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsOversizedServerAudioFrames() {
        val frame = ByteArray(CommanderProtocol.maxAudioFrameBytesForTest() + 2)
        frame[0] = SERVER_AUDIO_FRAME
        CommanderProtocol.decodeAudioFrame(frame)
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsAnotherProtocolVersion() {
        CommanderProtocol.parseServer(
            """{"type":"pong","protocol":"visor.v2","eventId":1,"sentAt":1,"requestId":"x","echoedSentAt":1}""",
        )
    }
}
