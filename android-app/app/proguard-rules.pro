# Keep JNI entrypoints and native method bindings
-keepclasseswithmembernames class * {
    native <methods>;
}

-keep class com.mobilecloud.** { *; }

# Keep Compose models and viewmodels
-keep class androidx.compose.** { *; }
