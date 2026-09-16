package ai.magnetgate.client

import android.app.Application
import android.util.Log

/**
 * Two gomobile bindings live in this app: libbox (the engine) and the core. Their shared support
 * classes (`go.Seq`, `go.Universe`) carry the native library name baked in, and the app ships a single
 * copy of them - otherwise it would not build, since both AARs contain the same classes. That copy
 * belongs to libbox, so it loads libbox and nothing would ever load the core's library.
 *
 * Both are therefore loaded here, before anything touches either binding: the JVM resolves a native
 * method against every library loaded in the process, so `mobile.Mobile` finds its implementations in
 * libgojni.so even though another class did the loading.
 */
class MagnetGateApp : Application() {
  override fun onCreate() {
    super.onCreate()
    System.loadLibrary("box")
    System.loadLibrary("gojni")
    Log.i("magnetgate", "native libraries loaded (box, gojni)")
  }
}
