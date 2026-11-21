package com.mobilecloud.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import com.mobilecloud.ui.theme.PrimaryCyan
import com.mobilecloud.ui.theme.Background
import com.mobilecloud.ui.theme.SurfaceElevated
import com.mobilecloud.ui.theme.TextPrimary
import com.mobilecloud.ui.theme.TextSecondary
import kotlinx.coroutines.delay

/**
 * GitHub interaction patterns (decompilation report §20.11) adapted to CIDS:
 * every empty list ships an illustration-free explanatory state with a CTA,
 * and every data screen gets the 3-stage progressive loading ladder instead
 * of a bare spinner.
 */

/** Empty state with CTA — "Nothing found" pattern, section 20.11.1. */
@Composable
fun EmptyState(
    title: String,
    subtitle: String,
    ctaLabel: String? = null,
    onCta: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.fillMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = androidx.compose.foundation.layout.Arrangement.Center,
    ) {
        Text(title, color = TextPrimary, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
        Spacer(modifier = Modifier.height(6.dp))
        Text(
            subtitle,
            color = TextSecondary,
            fontSize = 13.sp,
            modifier = Modifier.padding(horizontal = 32.dp),
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
        if (ctaLabel != null && onCta != null) {
            Spacer(modifier = Modifier.height(16.dp))
            Button(
                onClick = onCta,
                colors = ButtonDefaults.buttonColors(containerColor = PrimaryCyan, contentColor = Background),
            ) {
                Text(ctaLabel, fontSize = 12.sp, fontWeight = FontWeight.Bold)
            }
        }
    }
}

private enum class ProgressiveStage(val message: String) {
    FIRST("Syncing edge telemetry…"),
    SECOND("Still reconciling ledgers — hold tight…"),
    THIRD("Almost there…"),
}

/**
 * Progressive loading ladder (GitHub's "One moment please… → taking longer →
 * almost there", section 20.11.3). [variant] pins a stage for deterministic
 * previews; AUTO cycles every 4 seconds.
 */
enum class ProgressiveLoadingVariant { AUTO, FAST, SLOW, FINAL }

@Composable
fun ProgressiveLoadingIndicator(
    variant: ProgressiveLoadingVariant = ProgressiveLoadingVariant.AUTO,
    modifier: Modifier = Modifier,
) {
    var stage by remember { mutableIntStateOf(0) }
    if (variant == ProgressiveLoadingVariant.AUTO) {
        LaunchedEffect(Unit) {
            while (true) {
                delay(4_000)
                stage = (stage + 1) % ProgressiveStage.entries.size
            }
        }
    }
    val message = when (variant) {
        ProgressiveLoadingVariant.FAST -> ProgressiveStage.FIRST
        ProgressiveLoadingVariant.SLOW -> ProgressiveStage.SECOND
        ProgressiveLoadingVariant.FINAL -> ProgressiveStage.THIRD
        ProgressiveLoadingVariant.AUTO -> ProgressiveStage.entries[stage]
    }
    Column(modifier = modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Text(message.message, color = TextSecondary, fontSize = 13.sp)
        Spacer(modifier = Modifier.height(8.dp))
        LinearProgressIndicator(
            modifier = Modifier.width(180.dp),
            color = PrimaryCyan,
            trackColor = SurfaceElevated,
        )
    }
}
