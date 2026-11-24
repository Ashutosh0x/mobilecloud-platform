plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Release signing is driven entirely by the environment; no key material or
// password is committed. The release build is only signed when a keystore can
// actually be found, otherwise `signingConfig` stays null and Gradle produces
// an unsigned release APK instead of failing with a made-up password.
val releaseKeystore: File? = listOfNotNull(
    System.getenv("KEYSTORE_PATH")?.let { file(it) },
    file("../../mobilecloud-release.jks"),
    file("mobilecloud-release.jks"),
).firstOrNull { it.exists() }

android {
    // The R / BuildConfig classes must live in the root source package
    // (`com.mobilecloud.*`) because every screen and the terminal view import
    // `com.mobilecloud.R`. The store identity stays `com.mobilecloud.node`.
    namespace = "com.mobilecloud"
    compileSdk = 35
    ndkVersion = "27.1.12297006"

    defaultConfig {
        applicationId = "com.mobilecloud.node"
        minSdk = 30
        targetSdk = 35
        versionCode = 20261120
        versionName = "2.4.0-edge"

        ndk {
            abiFilters.addAll(listOf("arm64-v8a"))
        }

        externalNativeBuild {
            cmake {
                cppFlags("-O3 -fvisibility=hidden -std=c++20")
                arguments(
                    "-DANDROID_STL=c++_shared",
                    "-DCMAKE_SHARED_LINKER_FLAGS=-Wl,-z,max-page-size=16384"
                )
            }
        }
    }

    signingConfigs {
        releaseKeystore?.let { keystore ->
            create("release") {
                storeFile = keystore
                storePassword = System.getenv("KEYSTORE_PASSWORD")
                keyAlias = System.getenv("KEY_ALIAS")
                keyPassword = System.getenv("KEY_PASSWORD")
                enableV1Signing = true
                enableV2Signing = true
                enableV3Signing = true
                enableV4Signing = true
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            // Signed only when a real keystore is present; otherwise unsigned.
            signingConfig = releaseKeystore?.let { signingConfigs.getByName("release") }
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
        debug {
            applicationIdSuffix = ".debug"
            isDebuggable = true
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation(platform("androidx.compose:compose-bom:2024.11.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    // Extended icon set: Dashboard/Trading/PoR/Shell/Mesh tab glyphs.
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("androidx.biometric:biometric:1.1.0")
    // FragmentActivity host required by BiometricPrompt (App Lock gate).
    implementation("androidx.fragment:fragment-ktx:1.8.5")
    implementation("androidx.work:work-runtime-ktx:2.10.0")
    implementation("androidx.glance:glance-appwidget:1.1.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
}
