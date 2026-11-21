package com.mobilecloud

import android.content.Context
import java.io.File

/**
 * On-device directory layout (research report section 6.1 Tier-2 native
 * engine): the bundled ARM64 userland and the sandboxed shell HOME live
 * inside the app's private storage.
 */
object AppDirs {

    fun engineRoot(context: Context): File =
        File(context.filesDir, "engine").apply { mkdirs() }

    fun engineBin(context: Context): File =
        File(engineRoot(context), "bin").apply { mkdirs() }

    fun homeDir(context: Context): File =
        File(context.filesDir, "home").apply { mkdirs() }

    fun stateDir(context: Context): File =
        File(context.filesDir, "state").apply { mkdirs() }
}
