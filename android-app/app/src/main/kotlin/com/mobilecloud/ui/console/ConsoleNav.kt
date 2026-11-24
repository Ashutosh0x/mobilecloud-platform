package com.mobilecloud.ui.console

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.CreditCard
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Dns
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.GridView
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.MonitorHeart
import androidx.compose.material.icons.filled.RocketLaunch
import androidx.compose.material.icons.filled.Security
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.automirrored.filled.ShowChart
import androidx.compose.material.icons.filled.Smartphone
import androidx.compose.material.icons.filled.Speed
import androidx.compose.material.icons.filled.Storage
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.ui.graphics.vector.ImageVector

/** One console page — mirrors a `{ href, label, icon }` entry in the web `GROUPS`. */
data class NavItem(val href: String, val label: String, val icon: ImageVector)

/** A sidebar section — mirrors a `{ label, items }` entry in the web `GROUPS`. */
data class NavGroup(val label: String, val items: List<NavItem>)

/**
 * The 4 console groups, ported verbatim from `components/Shell.tsx`.
 * Routes use the same hrefs so the Android nav matches the web paths 1:1.
 */
val ConsoleGroups: List<NavGroup> = listOf(
    NavGroup(
        "Project",
        listOf(
            NavItem("/", "Overview", Icons.Filled.Home),
            NavItem("/projects", "Projects", Icons.Filled.Folder),
            NavItem("/deployments", "Deployments", Icons.Filled.RocketLaunch),
            NavItem("/builds", "Builds", Icons.Filled.RocketLaunch),
        ),
    ),
    NavGroup(
        "Observe",
        listOf(
            NavItem("/logs", "Logs", Icons.Filled.Description),
            NavItem("/analytics", "Analytics", Icons.AutoMirrored.Filled.ShowChart),
            NavItem("/monitoring", "Monitoring", Icons.Filled.MonitorHeart),
            NavItem("/observability", "Observability", Icons.Filled.MonitorHeart),
            NavItem("/speed", "Speed", Icons.Filled.Speed),
        ),
    ),
    NavGroup(
        "Security",
        listOf(
            NavItem("/firewall", "Firewall", Icons.Filled.Shield),
            NavItem("/device", "Link device", Icons.Filled.Security),
            NavItem("/settings", "Settings", Icons.Filled.Settings),
        ),
    ),
    NavGroup(
        "Infrastructure",
        listOf(
            NavItem("/domains", "Domains", Icons.Filled.Language),
            NavItem("/storage", "Storage", Icons.Filled.Storage),
            NavItem("/databases", "Databases", Icons.Filled.Dns),
            NavItem("/functions", "Functions", Icons.Filled.Bolt),
            NavItem("/workflows", "Workflows", Icons.Filled.AccountTree),
            NavItem("/shell", "CloudShell", Icons.Filled.GridView),
            NavItem("/node", "Node console", Icons.Filled.Smartphone),
            NavItem("/team", "Team", Icons.Filled.Group),
            NavItem("/billing", "Billing", Icons.Filled.CreditCard),
        ),
    ),
)

/** Flattened page list for the jump-to / search palette. */
val ConsolePages: List<NavItem> = ConsoleGroups.flatMap { it.items }

/** `G` then a key — the web `GO` shortcut map. */
val GoShortcuts: Map<String, String> = mapOf(
    "o" to "/", "p" to "/projects", "d" to "/deployments", "a" to "/analytics",
    "f" to "/firewall", "l" to "/logs", "s" to "/settings", "b" to "/builds",
)

fun navLabel(href: String): String = ConsolePages.firstOrNull { it.href == href }?.label ?: "Console"
