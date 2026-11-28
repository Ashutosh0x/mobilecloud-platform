plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

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
        versionName = "2.4.0-console"

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

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            // assembleRelease is unsigned. The release script alone aligns,
            // signs and verifies the distributable APK.
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
    // Passkeys for the unified authentication flows. The Play services provider
    // supplies the Android 11-13 backend that the platform Credential Manager
    // only ships from Android 14.
    implementation("androidx.credentials:credentials:1.3.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.3.0")
    implementation("androidx.work:work-runtime-ktx:2.10.0")
    implementation("androidx.glance:glance-appwidget:1.1.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    // JVM unit tests for the pure domain helpers (status/signal mapping, DNS
    // record derivation and hostname validation) — no Android framework needed.
    testImplementation("junit:junit:4.13.2")
    // QR scanner for "sign in by scanning the dashboard's code". The library
    // declares the CAMERA permission in its own manifest, so it is merged in
    // automatically; the app only has to request it at runtime.
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
}
