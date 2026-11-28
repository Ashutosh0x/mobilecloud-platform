# Starts the demo MobileCloud console.
#
#   .\scripts\start-demo.ps1
#
# The demo instance is a second client of the platform with its own database
# (`.tmp/demo.db`), its own realtime gateway (:3221) and its own build output
# (`.next-demo`). Demo authentication, demo seed data and demo background jobs
# therefore never touch the operator's data.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/instances.ps1')

Start-McInstance -Name 'demo'
