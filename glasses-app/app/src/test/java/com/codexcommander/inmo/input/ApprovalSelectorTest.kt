package com.codexcommander.inmo.input

import com.codexcommander.inmo.model.ApprovalChoice
import org.junit.Assert.assertEquals
import org.junit.Test

class ApprovalSelectorTest {
    @Test
    fun defaultsAndResetsToDecline() {
        val selector = ApprovalSelector()
        assertEquals(ApprovalChoice.DECLINE, selector.value)
        selector.move(1)
        assertEquals(ApprovalChoice.ACCEPT, selector.value)
        assertEquals(ApprovalChoice.DECLINE, selector.reset())
    }

    @Test
    fun wrapsInBothDirections() {
        val selector = ApprovalSelector()
        assertEquals(ApprovalChoice.CANCEL, selector.move(-1))
        assertEquals(ApprovalChoice.DECLINE, selector.move(1))
    }
}

