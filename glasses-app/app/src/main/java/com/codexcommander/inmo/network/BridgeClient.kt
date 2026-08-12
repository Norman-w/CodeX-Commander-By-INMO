package com.codexcommander.inmo.network

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import com.codexcommander.inmo.protocol.CommanderProtocol
import com.codexcommander.inmo.protocol.ServerMessage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.io.IOException
import java.util.concurrent.TimeUnit

class BridgeClient(
    private val listener: Listener,
) {
    interface Listener {
        fun onConnecting()
        fun onOpen()
        fun onMessage(message: ServerMessage)
        fun onAudio(pcm: ByteArray)
        fun onClosed(reason: String)
        fun onFailure(message: String)
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(12, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(25, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()
    @Volatile
    private var webSocket: WebSocket? = null
    @Volatile
    private var endpoint = ""
    @Volatile
    private var intentionallyClosed = false

    fun connect(endpoint: String) {
        require(endpoint.startsWith("wss://")) { "Bridge 必须使用 wss://" }
        disconnect()
        this.endpoint = endpoint
        intentionallyClosed = false
        listener.onConnecting()
        val request = Request.Builder().url(endpoint).build()
        webSocket = client.newWebSocket(request, SocketListener())
    }

    fun disconnect() {
        intentionallyClosed = true
        webSocket?.close(1000, "app backgrounded")
        webSocket = null
    }

    fun sendControl(json: String): Boolean = webSocket?.send(json) == true

    fun sendAudio(pcm: ByteArray): Boolean = webSocket?.send(
        ByteString.of(*CommanderProtocol.audioFrame(pcm)),
    ) == true

    suspend fun downloadImage(path: String, deviceId: String, token: String): Bitmap = withContext(Dispatchers.IO) {
        val httpEndpoint = "https://${endpoint.removePrefix("wss://")}"
        val base = httpEndpoint.toHttpUrl().newBuilder().encodedPath("/").query(null).build()
        val imageUrl = base.resolve(path) ?: throw IOException("无效图片地址")
        val request = Request.Builder()
            .url(imageUrl)
            .header("Authorization", "Bearer $token")
            .header("X-Device-Id", deviceId)
            .build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IOException("图片下载失败：HTTP ${response.code}")
            val body = response.body ?: throw IOException("图片响应为空")
            val declared = body.contentLength()
            if (declared > MAX_IMAGE_BYTES) throw IOException("图片超过眼镜端大小限制")
            val bytes = readBounded(body, MAX_IMAGE_BYTES)
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: throw IOException("无法解码 WebP 图片")
        }
    }

    fun close() {
        disconnect()
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
    }

    private inner class SocketListener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            if (this@BridgeClient.webSocket === webSocket) listener.onOpen()
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (this@BridgeClient.webSocket !== webSocket) return
            runCatching { CommanderProtocol.parseServer(text) }
                .onSuccess(listener::onMessage)
                .onFailure { listener.onFailure("协议消息无效：${it.message}") }
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            if (this@BridgeClient.webSocket !== webSocket) return
            runCatching { CommanderProtocol.decodeAudioFrame(bytes.toByteArray()) }
                .onSuccess(listener::onAudio)
                .onFailure { listener.onFailure("音频帧无效：${it.message}") }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, reason)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (this@BridgeClient.webSocket !== webSocket) return
            this@BridgeClient.webSocket = null
            if (!intentionallyClosed) listener.onClosed(reason.ifBlank { "连接已关闭 ($code)" })
        }

        override fun onFailure(webSocket: WebSocket, throwable: Throwable, response: Response?) {
            if (this@BridgeClient.webSocket !== webSocket) return
            this@BridgeClient.webSocket = null
            if (!intentionallyClosed) listener.onFailure(throwable.message ?: "Bridge 连接失败")
        }
    }

    private companion object {
        const val MAX_IMAGE_BYTES = 5 * 1024 * 1024

        fun readBounded(body: ResponseBody, limit: Int): ByteArray {
            body.source().use { source ->
                val bytes = source.readByteArray((limit + 1).toLong())
                if (bytes.size > limit) throw IOException("图片超过眼镜端大小限制")
                return bytes
            }
        }
    }
}
