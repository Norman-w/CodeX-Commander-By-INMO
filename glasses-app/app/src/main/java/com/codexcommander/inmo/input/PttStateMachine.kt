package com.codexcommander.inmo.input

import com.codexcommander.inmo.model.PttMode

enum class PttAction { NONE, START, STOP }

class PttStateMachine(mode: PttMode = PttMode.HOLD) {
    var mode: PttMode = mode
    var active: Boolean = false
        private set

    fun onDown(): PttAction {
        if (mode == PttMode.TOGGLE) {
            active = !active
            return if (active) PttAction.START else PttAction.STOP
        }
        if (active) return PttAction.NONE
        active = true
        return PttAction.START
    }

    fun onUp(): PttAction {
        return when (mode) {
            PttMode.HOLD -> if (active) {
                active = false
                PttAction.STOP
            } else {
                PttAction.NONE
            }
            PttMode.TOGGLE -> PttAction.NONE
        }
    }

    fun forceStop(): PttAction = if (active) {
        active = false
        PttAction.STOP
    } else {
        PttAction.NONE
    }
}
