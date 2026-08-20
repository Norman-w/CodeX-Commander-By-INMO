package com.codexcommander.inmo.ui

import com.codexcommander.inmo.model.ConnectionState
import org.junit.Assert.assertEquals
import org.junit.Test

class HudTextTest {
    @Test
    fun removesMarkdownNoiseWithoutDroppingReadableLabels() {
        val value = "# 完成\n- **测试**通过，见 [报告](https://example.com) 和 ![截图](/tmp/a.png)。"

        assertEquals("完成 测试通过，见 报告 和 截图。", HudText.plain(value))
    }

    @Test
    fun mapsTechnicalErrorsToActionableChinese() {
        assertEquals(
            "Mac 尚未配置 OpenAI API Key",
            HudText.friendlyError("realtime_not_configured", "OPENAI_API_KEY is not configured"),
        )
        assertEquals(
            "无法连接 Mac，请确认 Bridge 与 Tailscale 已启动",
            HudText.friendlyError(null, "failed to connect to host"),
        )
        assertEquals(
            "Codex 语音通道不可用。请关闭 ChatGPT 的 Voice Chat 后再说一次",
            HudText.friendlyError("realtime_unavailable", "stream disconnected before completion: Voice session access denied."),
        )
    }

    @Test
    fun usesHumanConnectionLabels() {
        assertEquals("Mac 已连接", HudText.connectionLabel(ConnectionState.CONNECTED))
        assertEquals("需要处理", HudText.connectionLabel(ConnectionState.ERROR))
    }

    @Test
    fun prefixesVoiceCaptions() {
        assertEquals("你：给首页加暗色模式", HudText.caption("user", "给首页加暗色模式"))
        assertEquals("Codex：已经开始改。", HudText.caption("assistant", "已经开始改。"))
    }

    @Test
    fun doesNotRepeatQueuedPhaseAsASecondLine() {
        assertEquals(true, HudText.duplicatesPhase("queued", "正在处理语音…"))
        assertEquals(true, HudText.duplicatesPhase("queued", "正在处理语音"))
        assertEquals(false, HudText.duplicatesPhase("queued", "给首页加暗色模式"))
    }
}
