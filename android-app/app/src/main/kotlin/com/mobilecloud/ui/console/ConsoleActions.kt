package com.mobilecloud.ui.console

import com.mobilecloud.console.ConsoleStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.json.JSONObject

/** Builds a JSON body, tolerating null values (stored as JSON null). */
fun jobj(vararg pairs: Pair<String, Any?>): JSONObject {
    val out = JSONObject()
    pairs.forEach { (key, value) -> out.put(key, value ?: JSONObject.NULL) }
    return out
}

/**
 * Port of the web `run()` helper: performs the call, toasts the server `note`
 * (or [ok] when absent), and toasts the error message on failure.
 */
fun ConsoleStore.action(scope: CoroutineScope, ok: String, block: suspend () -> JSONObject) {
    scope.launch {
        try {
            val result = block()
            notify(result.optString("note").ifEmpty { ok })
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            notify(error.message ?: "Request failed")
        }
    }
}
