package com.codexcommander.inmo.ui

import com.codexcommander.inmo.model.ConnectionState

object HudText {
    fun plain(value: String): String {
        val withoutImages = IMAGE.replace(value) { match -> match.groupValues[1] }
        val withoutLinks = LINK.replace(withoutImages) { match -> match.groupValues[1] }
        return withoutLinks
            .replace(CODE_FENCE, " ")
            .replace('`', ' ')
            .replace("**", "")
            .replace("__", "")
            .replace("~~", "")
            .lineSequence()
            .map { line -> line.replace(LINE_PREFIX, "").trim() }
            .filter(String::isNotEmpty)
            .joinToString(" ")
            .replace(MULTI_SPACE, " ")
            .trim()
    }

    fun connectionLabel(connection: ConnectionState): String = when (connection) {
        ConnectionState.UNCONFIGURED -> "等待设置"
        ConnectionState.CONNECTING -> "正在连接"
        ConnectionState.CONNECTED -> "Mac 已连接"
        ConnectionState.DISCONNECTED -> "连接已断开"
        ConnectionState.ERROR -> "需要处理"
    }

    fun phaseLabel(phase: String): String = when (phase) {
        "queued" -> "正在处理语音"
        "working" -> "Codex 执行中"
        "progress" -> "Codex 正在工作"
        "waiting_approval" -> "等待你确认"
        "completed" -> "任务已完成"
        "interrupted" -> "任务已中断"
        "failed" -> "任务失败"
        else -> "可以开始"
    }

    fun approvalResolution(resolution: String): String = when (resolution) {
        "accept" -> "已允许本次操作"
        "decline" -> "已拒绝操作"
        "cancel" -> "已取消请求"
        "expired" -> "审批已超时并自动取消"
        "resolved_elsewhere" -> "审批已在其他端处理"
        else -> "审批已处理"
    }

    fun caption(role: String, text: String): String {
        val spoken = plain(text)
        if (spoken.isEmpty()) return spoken
        return if (role == "user") "你：$spoken" else "Codex：$spoken"
    }

    fun friendlyError(code: String?, rawMessage: String): String {
        val raw = rawMessage.trim()
        val normalized = raw.lowercase()
        return when {
            code == "authentication_failed" -> "配对信息已失效，请输入 Mac 显示的新配对码"
            code == "ptt_too_short" || normalized.contains("shorter than 100") ->
                "说话时间太短，请按住后再说"
            code == "realtime_not_configured" || normalized.contains("openai_api_key") ->
                "Mac 尚未配置 OpenAI API Key"
            code == "realtime_unavailable" || code == "realtime_error" ->
                "语音服务暂时不可用，请稍后再试"
            normalized.contains("permission") && normalized.contains("record") ->
                "麦克风权限未开启，请在系统设置中允许录音"
            normalized.contains("unable to resolve host") || normalized.contains("failed to connect") ||
                normalized.contains("connection refused") || normalized.contains("timeout") ||
                normalized.contains("timed out") || normalized.contains("network") ->
                "无法连接 Mac，请确认 Bridge 与 Tailscale 已启动"
            normalized.contains("certificate") || normalized.contains("ssl") || normalized.contains("tls") ->
                "安全连接失败，请检查 Tailscale HTTPS 地址"
            raw.isBlank() -> "连接中断，正在尝试恢复"
            raw.length > 180 -> "操作失败，请在 Mac Bridge 日志中查看详情"
            else -> plain(raw)
        }
    }

    private val LINK = Regex("\\[([^]]+)]\\([^)]+\\)")
    private val IMAGE = Regex("!\\[([^]]*)]\\([^)]+\\)")
    private val CODE_FENCE = Regex("```[A-Za-z0-9_-]*")
    private val LINE_PREFIX = Regex("^\\s*(?:#{1,6}|[-*+]|\\d+[.)])\\s+")
    private val MULTI_SPACE = Regex("\\s+")
}
