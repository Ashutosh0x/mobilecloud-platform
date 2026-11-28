# Starts the operator's own MobileCloud console.
#
#   .\scripts\start-operator.ps1
#
# The operator instance serves the repository's own database on :3210 and
# writes its Next.js output to `.next-operator`, so it can never overwrite the
# demo or production build. Running the script twice is harmless: an instance
# that is already up is left alone.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/instances.ps1')

Start-McInstance -Name 'operator'
