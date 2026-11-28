# Starts the production MobileCloud console.
#
#   .\scripts\start-production.ps1
#
# The production instance serves the build in `.next-production` on :3230 with
# its own database (`.tmp/prod.db`) and its own realtime gateway (:3231).
# The build directory must already exist: `npm --prefix apps/web-dashboard run
# build` writes it. Set `MOBILECLOUD_PUBLIC_ORIGIN` before running this script
# when the console is behind a tunnel, so cookies, CSRF, WebAuthn and the
# OIDC issuer agree on one address.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/instances.ps1')

$instance = Get-McInstance 'production'
$buildDir = Join-Path (Join-Path $script:McRoot 'apps/web-dashboard') $instance.dist
if (-not (Test-Path (Join-Path $buildDir 'BUILD_ID'))) {
  Write-Output "no production build in $instance.dist - run: npm --prefix apps/web-dashboard run build"
  Write-Output "the console can still start in development mode, but it will not serve the production bundle."
}
if (-not $env:MOBILECLOUD_PUBLIC_ORIGIN) {
  Write-Output "MOBILECLOUD_PUBLIC_ORIGIN is not set. A production console requires an HTTPS origin: the API refuses to open the database without one, so the worker exits and the console serves nothing but its liveness probe."
  Write-Output "set it first, for example: `$env:MOBILECLOUD_PUBLIC_ORIGIN = 'https://auth.furlpay.com'"
}

Start-McInstance -Name 'production'
