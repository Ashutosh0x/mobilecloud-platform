# Stops the MobileCloud consoles.
#
#   .\scripts\stop-mobilecloud.ps1                # every instance
#   .\scripts\stop-mobilecloud.ps1 -Instance demo # one instance
#
# Only processes that belong to this repository are stopped: ownership is
# decided by the listening port *and* a command line that points at
# `apps/web-dashboard`. Unrelated Node services, the Codex runtime, the
# tunnels and the Rust engine are never touched, and no database is deleted.
param(
  [ValidateSet('operator', 'demo', 'production', 'all')]
  [string] $Instance = 'all'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/instances.ps1')

$targets = if ($Instance -eq 'all') { @('operator', 'demo', 'production') } else { @($Instance) }
foreach ($name in $targets) {
  Stop-McInstance -Name $name
}
