# Keep JNI entrypoints and native method bindings
-keepclasseswithmembernames class * {
    native <methods>;
}

-keep class com.mobilecloud.** { *; }

# Keep Compose models and viewmodels
-keep class androidx.compose.** { *; }

# QR pairing scanner. The capture activity and the decoder are reached through
# the library's manifest and internal lookup tables, so a minified release build
# must not strip them or scanning silently fails at runtime.
-keep class com.journeyapps.barcodescanner.** { *; }
-keep class com.google.zxing.** { *; }
