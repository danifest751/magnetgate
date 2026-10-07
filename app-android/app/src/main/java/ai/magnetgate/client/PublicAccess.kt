package ai.magnetgate.client

import android.content.Context
import org.json.JSONObject
import java.net.URL
import java.security.SecureRandom
import javax.net.ssl.HttpsURLConnection

/** Личный доступ не использует общий ключ частной группы. */
object PublicAccess {
  @Volatile private var profile: JSONObject? = null
  fun enabled(context: Context) = Settings.publicCode(context).isNotBlank()
  private fun device(context: Context): String {
    val saved = Settings.publicDevice(context)
    if (Regex("[a-f0-9]{64}").matches(saved)) return saved
    val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
    val value = bytes.joinToString("") { "%02x".format(it) }
    check(Settings.savePublicDevice(context, value)) { "Не удалось сохранить идентификатор устройства." }
    return value
  }
  fun activate(context: Context, code: String) {
    val result = fetch(code.trim(), device(context))
    check(Settings.savePublicCode(context, code.trim())) { "Защищённое хранилище недоступно." }
    profile = result
  }
  fun refresh(context: Context) { profile = fetch(Settings.publicCode(context), device(context)) }
  fun clear(context: Context) { check(Settings.savePublicCode(context, "")); profile = null }
  fun nodes(): List<DiscoveredNode> {
    val current = profile ?: return emptyList()
    if (current.optLong("expires") <= System.currentTimeMillis() / 1000) return emptyList()
    val endpoints = current.getJSONArray("endpoints")
    return (0 until endpoints.length()).map { index ->
      val item = endpoints.getJSONObject(index)
      DiscoveredNode(index, listOf(item), item.getString("country"))
    }
  }
  fun status(context: Context) = CoreStatus(
    running = MgVpnService.isRunning(), country = Settings.country(context),
    sent = MgVpnService.publicTraffic().sent, received = MgVpnService.publicTraffic().received,
    countries = nodes().map { CountryRow(it.country, 1) },
    nodes = nodes().map { NodeRow(it.slot, "MagnetGate", "Личный доступ", it.country, listOf(Plane("hy2", "")), emptyList()) },
  )
  private fun fetch(code: String, device: String): JSONObject {
    require(Regex("MG1-[a-f0-9]{64}").matches(code)) { "Вставьте личный код с сайта magnet.norma.so. Он начинается с MG1-." }
    val connection = URL("https://magnet.norma.so/api/profile").openConnection() as HttpsURLConnection
    connection.instanceFollowRedirects = false
    connection.connectTimeout = 15000
    connection.readTimeout = 15000
    connection.requestMethod = "POST"
    connection.doOutput = true
    connection.setRequestProperty("Content-Type", "application/json")
    try {
      connection.outputStream.use { it.write(JSONObject().put("code", code).put("device", device).toString().toByteArray()) }
      val success = connection.responseCode == 200
      val stream = if (success) connection.inputStream else connection.errorStream
      val bytes = stream?.use {
        val output = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(4096)
        while (true) {
          val count = it.read(buffer)
          if (count < 0) break
          require(output.size() + count <= 24000) { "Слишком большой ответ сервиса." }
          output.write(buffer, 0, count)
        }
        output.toByteArray()
      } ?: error("Сервис доступа недоступен.")
      require(bytes.size <= 24000) { "Слишком большой ответ сервиса." }
      val result = JSONObject(String(bytes, Charsets.UTF_8))
      check(success) { result.optString("error", "Сервис доступа недоступен.").take(240) }
      require(result.optInt("version") == 1 && result.optLong("expires") > System.currentTimeMillis() / 1000)
      val endpoints = result.getJSONArray("endpoints")
      require(endpoints.length() in 1..4)
      for (index in 0 until endpoints.length()) {
        val item = endpoints.getJSONObject(index)
        val host = item.getString("host")
        require(Regex("(?:[0-9]{1,3}\\.){3}[0-9]{1,3}").matches(host))
        val address = java.net.InetAddress.getByName(host)
        require(!address.isAnyLocalAddress && !address.isLoopbackAddress && !address.isLinkLocalAddress && !address.isSiteLocalAddress && !address.isMulticastAddress)
        require(item.getString("t") == "hy2" && item.getInt("port") == 4443)
        require(item.getString("country") in listOf("NL", "FI") && item.getString("sni") == "magnet.norma.so")
        require(Regex("[a-f0-9]{64}").matches(item.getString("pw")) && Regex("[a-f0-9]{64}").matches(item.getString("obfs")))
        require(item.getString("ca").startsWith("-----BEGIN CERTIFICATE-----") && item.getString("ca").length <= 4096)
      }
      return result
    } finally { connection.disconnect() }
  }
}
