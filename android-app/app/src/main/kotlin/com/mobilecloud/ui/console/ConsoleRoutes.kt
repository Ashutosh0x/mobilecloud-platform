package com.mobilecloud.ui.console

import androidx.compose.runtime.Composable
import com.mobilecloud.console.ConsoleStore
import com.mobilecloud.ui.console.pages.AnalyticsPage
import com.mobilecloud.ui.console.pages.BillingPage
import com.mobilecloud.ui.console.pages.BuildsPage
import com.mobilecloud.ui.console.pages.DatabasesPage
import com.mobilecloud.ui.console.pages.DeploymentsPage
import com.mobilecloud.ui.console.pages.DevicePage
import com.mobilecloud.ui.console.pages.DomainsPage
import com.mobilecloud.ui.console.pages.FirewallPage
import com.mobilecloud.ui.console.pages.FunctionsPage
import com.mobilecloud.ui.console.pages.LogsPage
import com.mobilecloud.ui.console.pages.MonitoringPage
import com.mobilecloud.ui.console.pages.NodeConsolePage
import com.mobilecloud.ui.console.pages.ObservabilityPage
import com.mobilecloud.ui.console.pages.OverviewPage
import com.mobilecloud.ui.console.pages.ProjectsPage
import com.mobilecloud.ui.console.pages.SettingsPage
import com.mobilecloud.ui.console.pages.SpeedPage
import com.mobilecloud.ui.console.pages.StoragePage
import com.mobilecloud.ui.console.pages.TeamPage
import com.mobilecloud.ui.console.pages.WorkflowsPage

/** Route table — mirrors the web `app/(console)` page tree 1:1.
 *
 * `/shell` is deliberately absent: [com.mobilecloud.ui.console.ConsoleShell]
 * renders the real PTY terminal outside the scrolling content slot, so the
 * canvas gets a bounded height. */
@Composable
fun ConsoleRoutes(store: ConsoleStore, route: String, onNavigate: (String) -> Unit) {
    when (route) {
        "/" -> OverviewPage(store, onNavigate)
        "/projects" -> ProjectsPage(store)
        "/deployments" -> DeploymentsPage(store)
        "/builds" -> BuildsPage(store)
        "/logs" -> LogsPage(store)
        "/analytics" -> AnalyticsPage(store)
        "/monitoring" -> MonitoringPage(store)
        "/observability" -> ObservabilityPage(store)
        "/speed" -> SpeedPage(store)
        "/firewall" -> FirewallPage(store)
        "/device" -> DevicePage(store)
        "/settings" -> SettingsPage(store)
        "/domains" -> DomainsPage(store)
        "/storage" -> StoragePage(store)
        "/databases" -> DatabasesPage(store)
        "/functions" -> FunctionsPage(store)
        "/workflows" -> WorkflowsPage(store)
        "/node" -> NodeConsolePage(store, onNavigate)
        "/team" -> TeamPage(store)
        "/billing" -> BillingPage(store)
        else -> OverviewPage(store, onNavigate)
    }
}
