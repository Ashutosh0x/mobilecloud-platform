# Verifies the local MobileCloud runtime.
#
#   .\scripts\health-mobilecloud.ps1
#
# HTTP 200 alone is not proof that a dashboard works: a clobbered build
# directory still serves HTML while its CSS and JavaScript 404. This script
# therefore fetches each dashboard, requests every `/_next/static` asset it
# references, checks that each instance owns a distinct database and build
# directory, and looks for a worker restart loop in the logs.
#
# The exit code is 0 when every check passed and 1 otherwise.
param(
  [switch] $RequireProduction
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'lib/instances.ps1')

$failures = New-Object System.Collections.Generic.List[string]
$rows = New-Object System.Collections.Generic.List[object]
$skipped = New-Object System.Collections.Generic.List[string]

function Add-Result {
  param([string] $Check, [string] $Target, [bool] $Ok, [string] $Detail)
  $script:rows.Add([pscustomobject]@{ Check = $Check; Target = $Target; Ok = $Ok; Detail = $Detail })
  if (-not $Ok) { $script:failures.Add("$Check - $Target - $Detail") }
}

function Add-Skipped {
  param([string] $Check, [string] $Target, [string] $Detail)
  $script:rows.Add([pscustomobject]@{ Check = $Check; Target = $Target; Ok = $null; Detail = $Detail })
  $script:skipped.Add("$Check - $Target - $Detail")
}

$instances = @('operator', 'demo', 'production')
$databases = @{}
$distDirs = @{}

foreach ($name in $instances) {
  $instance = Get-McInstance $name
  $base = "http://127.0.0.1:$($instance.port)"

  # --- the dashboard -------------------------------------------------------
  $owner = Get-McPortOwner $instance.port
  if (-not $owner) {
    if ($name -eq 'production' -and -not $RequireProduction) {
      Add-Skipped 'listening' $name "nothing is listening on port $($instance.port) - the production instance is optional"
    } else {
      Add-Result 'listening' $name $false "nothing is listening on port $($instance.port)"
    }
  } else {
    $process = Get-McProcess $owner
    $owned = Test-McOwnedProcess $process
    Add-Result 'listening' $name $owned "pid $owner - $(if ($owned) { 'owned by this repository' } else { 'NOT part of this repository' })"
  }

  try {
    $health = Invoke-WebRequest -Uri "$base/api/health" -UseBasicParsing -TimeoutSec 20
    $body = $health.Content | ConvertFrom-Json
    Add-Result 'api/health' $name ($health.StatusCode -eq 200) "HTTP $($health.StatusCode) - $($body.status)"
  } catch {
    if ($name -eq 'production' -and -not $RequireProduction) {
      Add-Skipped 'api/health' $name $_.Exception.Message
    } else {
      Add-Result 'api/health' $name $false $_.Exception.Message
    }
  }

  # --- the realtime gateway ------------------------------------------------
  try {
    $realtime = Invoke-WebRequest -Uri "http://127.0.0.1:$($instance.realtime)/api/health" -UseBasicParsing -TimeoutSec 20
    Add-Result 'realtime' $name ($realtime.StatusCode -eq 200) "HTTP $($realtime.StatusCode) on :$($instance.realtime)"
  } catch {
    if ($name -eq 'production' -and -not $RequireProduction) {
      Add-Skipped 'realtime' $name $_.Exception.Message
    } else {
      Add-Result 'realtime' $name $false $_.Exception.Message
    }
  }

  # --- the HTML and every asset it references ------------------------------
  $assets = Test-McDashboardAssets $base
  if ($assets.error) {
    if ($name -eq 'production' -and -not $RequireProduction) {
      Add-Skipped 'assets' $name $assets.error
    } else {
      Add-Result 'assets' $name $false $assets.error
    }
  } else {
    Add-Result 'html' $name ($assets.htmlStatus -eq 200) "HTTP $($assets.htmlStatus)"
    $ok = $assets.failedAssets.Count -eq 0
    $detail = if ($ok) { "$($assets.assets) assets served" } else { "$($assets.failedAssets.Count) of $($assets.assets) assets failed: $($assets.failedAssets -join ', ')" }
    Add-Result 'assets' $name $ok $detail
  }

  # --- isolation -----------------------------------------------------------
  $databases[$name] = $instance.database
  $distDirs[$name] = $instance.dist
  $dbExists = Test-Path $instance.database
  Add-Result 'database' $name $dbExists $instance.database
}

# --- databases are not shared ----------------------------------------------
$duplicateDatabases = $databases.GetEnumerator() | Group-Object Value | Where-Object { $_.Count -gt 1 }
Add-Result 'database isolation' 'all' ($duplicateDatabases.Count -eq 0) `
  $(if ($duplicateDatabases.Count -eq 0) { 'every instance has its own database' } else { "shared: $(($duplicateDatabases | ForEach-Object { $_.Name }) -join ', ')" })

# --- build directories are not shared --------------------------------------
$duplicateDirs = $distDirs.GetEnumerator() | Group-Object Value | Where-Object { $_.Count -gt 1 }
Add-Result 'build isolation' 'all' ($duplicateDirs.Count -eq 0) `
  $(if ($duplicateDirs.Count -eq 0) { 'every instance has its own build directory' } else { "shared: $(($duplicateDirs | ForEach-Object { $_.Name }) -join ', ')" })

# --- no worker restart loop ------------------------------------------------
# The log file is rewritten on every start, so these lines belong to the
# current run. A worker that exits is restarted by the supervisor; three
# restarts in one run means the worker is crash-looping and the webhook
# delivery queue is not being drained.
foreach ($name in $instances) {
  $log = Join-Path $script:McLogs "$name-console.err.log"
  if (-not (Test-Path $log)) { continue }
  $restarts = @(Select-String -Path $log -Pattern '\[run\] worker stopped' -ErrorAction SilentlyContinue)
  Add-Result 'worker restarts' $name ($restarts.Count -lt 3) "$($restarts.Count) worker restarts logged"
}

# --- report ----------------------------------------------------------------
$rows | Format-Table -AutoSize | Out-String -Width 200 | Write-Output
if ($skipped.Count -gt 0) {
  Write-Output "Skipped:"
  $skipped | ForEach-Object { Write-Output "  - $_" }
}
if ($failures.Count -gt 0) {
  Write-Output "FAILED ($($failures.Count)):"
  $failures | ForEach-Object { Write-Output "  - $_" }
  exit 1
}
Write-Output 'All checks passed.'
exit 0
