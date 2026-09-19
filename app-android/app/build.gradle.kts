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

  // Release signing. The keystore and its password live in key/, which sits outside this repository
  // beside the other secrets and is never committed - losing it means never being able to update an
  // installed app again, because Android refuses an update signed by a different key.
  //
  // A checkout without the key still builds: only the release variant goes unsigned, and it says so.
  // Point elsewhere with -Pmagnetgate.keyDir=<path> or MAGNETGATE_KEY_DIR.
  // rootDir is app-android/, and key/ sits beside the repository itself, two levels up.
  val keyDir = (project.findProperty("magnetgate.keyDir") as String?)?.let { file(it) }
    ?: System.getenv("MAGNETGATE_KEY_DIR")?.let { file(it) }
    ?: rootDir.parentFile.parentFile.resolve("key")
  val keyStoreFile = File(keyDir, "magnetgate-release.jks")
  val keyPassFile = File(keyDir, "magnetgate-release.pass")
  val releaseKey = keyStoreFile.isFile && keyPassFile.isFile

  signingConfigs {
    if (releaseKey) {
      create("release") {
        val secret = keyPassFile.readText().trim()
        storeFile = keyStoreFile
        storePassword = secret
        keyAlias = "magnetgate"
        keyPassword = secret
      }
    }
  }

  buildTypes {
    getByName("release") {
      if (releaseKey) {
        signingConfig = signingConfigs.getByName("release")
      } else {
        logger.lifecycle("release signing: no key at " + keyStoreFile.path + " - the release build will be unsigned")
      }
    }
  }

  buildFeatures {
    compose = true
  }

  // Оба языка доступны офлайн, в том числе при установке из App Bundle.
  bundle {
    language {
      enableSplit = false
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  kotlinOptions {
    jvmTarget = "17"
  }

  // One libmgcore.so is ~82 MB, so a package carrying every ABI came to ~188 MB and most of it was
  // dead weight on any given device. We target arm64-v8a phones and x86_64 emulators; 32-bit phones
  // are not supported by these APKs. No universal APK: it would be the old fat one, and the
  // scripts pick the package matching the device's ABI.
  splits {
    abi {
      isEnable = true
      reset()
      include("arm64-v8a", "x86_64")
      isUniversalApk = false
    }
  }

  androidResources {
    // RuleSets.ensure opens these with openFd, which only works on an uncompressed asset. They are
    // already compact binaries, so deflating them buys nothing anyway.
    noCompress += "srs"
  }

  packaging {
    resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
  }
}

// The routing rule-sets come from the same place the desktop gets them: tools/sing-box/, fetched by
// scripts/get-singbox.ps1 against the SHA-256 pins in scripts/pins.json. They are copied into the
// package rather than committed, so the phone routes by the same pinned list as the desktop.
//
// A missing file is deliberately not an error: a checkout that has not run get-singbox.ps1 still builds
// an app that tunnels, it just has nothing to split on. The build says which ones it found.
val ruleSetsDir = rootProject.layout.projectDirectory.dir("../tools/sing-box")
val packRuleSets by tasks.registering(Copy::class) {
  from(ruleSetsDir) { include("*.srs") }
  into(layout.buildDirectory.dir("generated/ruleSets/rule-sets"))
  doFirst {
    val found = ruleSetsDir.asFile.listFiles { f -> f.name.endsWith(".srs") }?.map { it.name }.orEmpty()
    if (found.isEmpty()) logger.lifecycle("rule-sets: none found in ${ruleSetsDir.asFile} - split mode will have no lists")
    else logger.lifecycle("rule-sets: packaging ${found.joinToString(", ")}")
  }
}

android.sourceSets.getByName("main").assets.srcDir(layout.buildDirectory.dir("generated/ruleSets"))
tasks.named("preBuild") { dependsOn(packRuleSets) }

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
  testImplementation("junit:junit:4.13.2")
}
