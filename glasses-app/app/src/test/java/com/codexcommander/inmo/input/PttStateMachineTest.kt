package com.codexcommander.inmo.input

import com.codexcommander.inmo.model.PttMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class PttStateMachineTest {
    @Test
    fun holdModeStartsOnDownAndStopsOnUp() {
        val machine = PttStateMachine(PttMode.HOLD)
        assertEquals(PttAction.START, machine.onDown())
        assertEquals(PttAction.NONE, machine.onDown())
        assertEquals(PttAction.STOP, machine.onUp())
        assertFalse(machine.active)
    }

    @Test
    fun toggleModeChangesOnlyOnDown() {
        val machine = PttStateMachine(PttMode.TOGGLE)
        assertEquals(PttAction.START, machine.onDown())
        assertEquals(PttAction.NONE, machine.onUp())
        assertEquals(PttAction.STOP, machine.onDown())
        assertEquals(PttAction.NONE, machine.onUp())
    }

    @Test
    fun forceStopIsIdempotent() {
        val machine = PttStateMachine(PttMode.HOLD)
        machine.onDown()
        assertEquals(PttAction.STOP, machine.forceStop())
        assertEquals(PttAction.NONE, machine.forceStop())
    }
}

