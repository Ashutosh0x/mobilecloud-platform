# Restarts the MobileCloud consoles.
#
#   .\scripts\restart-mobilecloud.ps1                # every instance
#   .\scripts\restart-mobilecloud.ps1 -Instance demo # one instance
#
# The restart preserves databases, sessions and every unrelated service: it
# stops only the processes this repository owns and starts the same instances
# again with the same build directories and databases.
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
foreach ($name in $targets) {
  Start-McInstance -Name $name
}
