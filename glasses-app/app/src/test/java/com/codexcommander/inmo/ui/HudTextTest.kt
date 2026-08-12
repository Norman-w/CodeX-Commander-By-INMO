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
    }

    @Test
    fun usesHumanConnectionLabels() {
        assertEquals("Mac 已连接", HudText.connectionLabel(ConnectionState.CONNECTED))
        assertEquals("需要处理", HudText.connectionLabel(ConnectionState.ERROR))
    }
}
