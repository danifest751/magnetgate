plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
  id("org.jetbrains.kotlin.plugin.compose")
}

android {
  namespace = "ai.magnetgate.client"
  compileSdk = 35

  defaultConfig {
    applicationId = "ai.magnetgate.client"
    minSdk = 26
    targetSdk = 35
    versionCode = 1
    versionName = "0.1.0"
  }

  buildFeatures {
    compose = true
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  kotlinOptions {
    jvmTarget = "17"
  }

  // One libmgcore.so is ~82 MB, so a package carrying every ABI came to ~188 MB and most of it was
  // dead weight on any given device. arm64-v8a is every real phone, x86_64 is the emulator; nothing
  // else is a target. No universal APK: it would just be the old fat one under a new name, and the
  // scripts pick the package matching the device's ABI.
  splits {
    abi {
      isEnable = true
      reset()
      include("arm64-v8a", "x86_64")
      isUniversalApk = false
    }
  }

  packaging {
    resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
  }
}

dependencies {
  // The core and the engine in one binding, built from the pinned sing-box commit by
  // scripts/android/build-aar.ps1: one Go runtime, and one set of support classes
  implementation(files("../libs/mgcore.aar"))

  implementation("androidx.core:core-ktx:1.13.1")
  implementation("androidx.activity:activity-compose:1.9.3")
  implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
  // the PSK is kept in an EncryptedSharedPreferences, whose master key is in the Android Keystore
  implementation("androidx.security:security-crypto:1.1.0-alpha06")

  implementation(platform("androidx.compose:compose-bom:2024.10.01"))
  implementation("androidx.compose.ui:ui")
  implementation("androidx.compose.material3:material3")
}
