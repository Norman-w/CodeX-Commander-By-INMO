package com.codexcommander.inmo.input

import com.codexcommander.inmo.model.ApprovalChoice

class ApprovalSelector(initial: ApprovalChoice = ApprovalChoice.DECLINE) {
    var value: ApprovalChoice = initial
        private set

    fun move(direction: Int): ApprovalChoice {
        val values = ApprovalChoice.entries
        val next = (values.indexOf(value) + if (direction >= 0) 1 else -1).mod(values.size)
        value = values[next]
        return value
    }

    fun reset(): ApprovalChoice {
        value = ApprovalChoice.DECLINE
        return value
    }
}

