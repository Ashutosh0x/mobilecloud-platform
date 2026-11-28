# Shared runtime definitions for the MobileCloud operational scripts.
#
# Every instance owns its own port, realtime port, build directory and
# database. Nothing here stops a process that is not part of this repository:
# ownership is decided by the listening port *and* the command line, so the
# Codex runtime, other Node services and the tunnels are never touched.

$script:McRoot = (Resolve-Path (Join-Path (Join-Path $PSScriptRoot '..') '..')).Path
$script:McApp = Join-Path $script:McRoot 'apps/web-dashboard'
$script:McLogs = Join-Path $script:McRoot '.tmp'
$script:McNode = 'C:\Program Files\nodejs\node.exe'

function Get-McInstance {
  <#
    .SYNOPSIS
      The runtime definition of one MobileCloud instance.
  #>
  param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('operator', 'demo', 'production')]
    [string] $Name
  )

  $root = $script:McRoot
  switch ($Name) {
    'operator' {
      return @{
        name = 'operator'
        port = 3210
        realtime = 3211
        mode = 'dev'
        dist = '.next-operator'
        database = Join-Path $root 'apps/web-dashboard/data/mobilecloud.db'
        dataRoot = Join-Path $root 'apps/web-dashboard/data'
        publicOrigin = $null
        bootstrapEmail = 'owner@mobilecloud.local'
        bootstrapPassword = 'mobilecloud-local-2026'
      }
    }
    'demo' {
      return @{
        name = 'demo'
        port = 3220
        realtime = 3221
        mode = 'dev'
        dist = '.next-demo'
        database = Join-Path $root '.tmp/demo.db'
        dataRoot = Join-Path $root '.tmp'
        publicOrigin = $null
        bootstrapEmail = 'owner@mobilecloud.local'
        bootstrapPassword = 'mobilecloud-local-2026'
      }
    }
    'production' {
      return @{
        name = 'production'
        port = 3230
        realtime = 3231
        mode = 'start'
        dist = '.next-production'
        database = Join-Path $root '.tmp/prod.db'
        dataRoot = Join-Path $root '.tmp'
        publicOrigin = $env:MOBILECLOUD_PUBLIC_ORIGIN
        bootstrapEmail = 'owner@mobilecloud.local'
        bootstrapPassword = 'mobilecloud-local-2026'
      }
    }
  }
}

function Get-McPortOwner {
  <#
    .SYNOPSIS
      The process listening on a TCP port, or $null.
  #>
  param([int] $Port)

  try {
    $connection = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop |
      Select-Object -First 1
  } catch {
    return $null
  }
  if (-not $connection) { return $null }
  return $connection.OwningProcess
}

function Get-McProcess {
  param([int] $ProcessId)
  if (-not $ProcessId) { return $null }
  try {
    return Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
  } catch {
    return $null
  }
}

function Test-McOwnedProcess {
  <#
    .SYNOPSIS
      True when the process belongs to this repository's console.

    .DESCRIPTION
      Ownership requires the command line to point at this repository's web
      dashboard. A process that merely listens on the port is not enough: an
      unrelated service on 3210 must never be stopped by these scripts.
  #>
  param($Process)

  if (-not $Process) { return $false }
  $command = "$($Process.CommandLine)"
  if (-not $command) { return $false }
  return ($command -like '*mobilecloud-platform*') -and ($command -like '*web-dashboard*')
}

function Get-McInstanceSupervisor {
  <#
    .SYNOPSIS
      The `server/run.mjs` process that supervises an instance, if any.

    .DESCRIPTION
      The supervisor is found by walking up from a process that already
      belongs to this repository, so the match is on the script name alone:
      the command line may hold a relative path.
  #>
  param([int] $ProcessId)

  $current = $ProcessId
  for ($depth = 0; $depth -lt 5 -and $current; $depth++) {
    $process = Get-McProcess $current
    if (-not $process) { return $null }
    if ($process.CommandLine -like '*run.mjs*') { return $process }
    $current = [int] $process.ParentProcessId
    if ($current -le 0) { return $null }
  }
  return $null
}

function Get-McInstanceNextPid {
  <#
    .SYNOPSIS
      The `next dev`/`next start` process serving an instance's port.

    .DESCRIPTION
      The Next.js process carries `--port <port>` on its command line, which
      is the one signal that identifies an instance even when the supervisor
      has already died and the port owner is an orphan.
  #>
  param([hashtable] $Instance)

  $pattern = "*web-dashboard*--port $($Instance.port)*"
  $found = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like $pattern }
  if (-not $found) { return $null }
  return @($found | ForEach-Object { [int] $_.ProcessId })
}

function Get-McInstanceProcessIds {
  <#
    .SYNOPSIS
      Every process that currently belongs to one instance: the supervisor,
      the web server, the realtime gateway and the webhook worker.
  #>
  param([hashtable] $Instance)

  $ids = New-Object System.Collections.Generic.HashSet[int]
  foreach ($port in @($Instance.port, $Instance.realtime)) {
    $owner = Get-McPortOwner $port
    if ($owner) { [void] $ids.Add([int] $owner) }
  }
  foreach ($id in @($ids)) {
    $supervisor = Get-McInstanceSupervisor $id
    if ($supervisor) {
      [void] $ids.Add([int] $supervisor.ProcessId)
      foreach ($child in (Get-McTreeIds ([int] $supervisor.ProcessId))) { [void] $ids.Add([int] $child) }
    }
  }
  return @($ids)
}

function Get-McTreeIds {
  <#
    .SYNOPSIS
      Every descendant of a process, deepest first.

    .DESCRIPTION
      The process tree is collected *before* anything is stopped. The
      supervisor restarts a child that exits, so the supervisor has to die
      first; the descendants it would respawn are then stopped explicitly,
      because once the supervisor is gone they are orphans and can no longer
      be found through the parent chain.
  #>
  param([int] $ProcessId)

  $ids = New-Object System.Collections.Generic.List[int]
  $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" -ErrorAction SilentlyContinue
  foreach ($child in $children) {
    foreach ($id in (Get-McTreeIds $child.ProcessId)) { $ids.Add($id) }
    $ids.Add([int] $child.ProcessId)
  }
  return @($ids)
}

function Stop-McInstance {
  <#
    .SYNOPSIS
      Stops one instance, and only that instance.

    .DESCRIPTION
      The supervisor is stopped first so it cannot respawn a child while the
      rest of the tree is going down, then every process collected from its
      tree is stopped. A port held by a process that is not part of this
      repository is reported and left alone, and no database is touched.
  #>
  param(
    [Parameter(Mandatory = $true)]
    [string] $Name,
    [switch] $Quiet
  )

  $instance = Get-McInstance $Name

  foreach ($port in @($instance.port, $instance.realtime)) {
    $owner = Get-McPortOwner $port
    if (-not $owner) { continue }
    $process = Get-McProcess $owner
    if (-not (Test-McOwnedProcess $process)) {
      Write-Warning "port $port is held by a process that is not part of this repository (pid $owner). It is left alone."
    }
  }

  # Collect the whole tree while the parent links are still intact.
  $supervisors = New-Object System.Collections.Generic.List[int]
  $tree = New-Object System.Collections.Generic.List[int]
  $roots = New-Object System.Collections.Generic.List[int]

  # The Next.js process for this port is the anchor: it identifies the
  # instance even when the supervisor is gone.
  foreach ($id in (Get-McInstanceNextPid $instance)) { $roots.Add([int] $id) }
  foreach ($port in @($instance.port, $instance.realtime)) {
    $owner = Get-McPortOwner $port
    if ($owner) { $roots.Add([int] $owner) }
  }

  foreach ($root in @($roots | Select-Object -Unique)) {
    $supervisor = Get-McInstanceSupervisor $root
    if ($supervisor) {
      $supervisorId = [int] $supervisor.ProcessId
      if (-not $supervisors.Contains($supervisorId)) {
        $supervisors.Add($supervisorId)
        foreach ($id in (Get-McTreeIds $supervisorId)) { $tree.Add([int] $id) }
      }
    } else {
      # An orphan: the supervisor is already gone but one of its children
      # still holds the port. It belongs to this instance, so it is stopped
      # too.
      $ownerProcess = Get-McProcess $root
      if (Test-McOwnedProcess $ownerProcess) {
        $tree.Add([int] $root)
        foreach ($id in (Get-McTreeIds ([int] $root))) { $tree.Add([int] $id) }
      }
    }
  }

  if ($supervisors.Count -eq 0 -and $tree.Count -eq 0) {
    if (-not $Quiet) { Write-Output "$Name is not running." }
    return
  }

  # 1. The supervisor dies first, so it cannot respawn what follows.
  foreach ($id in $supervisors) {
    if (-not $Quiet) { Write-Output "stopping $Name supervisor (pid $id)" }
    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 700

  # 2. The rest of the tree goes with it.
  foreach ($id in $tree) {
    $process = Get-McProcess $id
    if ($process -and (Test-McOwnedProcess $process)) {
      if (-not $Quiet) { Write-Output "stopping pid $id" }
      Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
    }
  }

  # 3. Confirm the ports are released; repeat once if something lingered.
  for ($attempt = 0; $attempt -lt 3; $attempt++) {
    $busy = @(@($instance.port, $instance.realtime) | Where-Object { Get-McPortOwner $_ })
    if ($busy.Count -eq 0) { break }
    Start-Sleep -Milliseconds 800
    foreach ($port in $busy) {
      $owner = Get-McPortOwner $port
      $process = Get-McProcess $owner
      if ($process -and (Test-McOwnedProcess $process)) {
        Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
      }
    }
  }

  # `taskkill` and `Stop-Process` set the native exit code; a child that had
  # already exited is not a failure for this script.
  $global:LASTEXITCODE = 0
  if (-not $Quiet) { Write-Output "$Name stopped." }
}

function Start-McInstance {
  <#
    .SYNOPSIS
      Starts one instance with its own build directory and database.

    .DESCRIPTION
      The script is safe to run repeatedly: an instance that is already
      running is left alone. A port held by a foreign process is reported and
      never taken over.
  #>
  param(
    [Parameter(Mandatory = $true)]
    [string] $Name
  )

  $instance = Get-McInstance $Name
  if (-not (Test-Path $script:McLogs)) { New-Item -ItemType Directory -Path $script:McLogs | Out-Null }
  if (-not (Test-Path $script:McNode)) { throw "Node.js was not found at $($script:McNode)." }

  $existing = Get-McInstanceNextPid $instance
  if ($existing) {
    Write-Output "$Name is already running on port $($instance.port) (pid $($existing -join ', '))."
    return
  }

  $owner = Get-McPortOwner $instance.port
  if ($owner) {
    $process = Get-McProcess $owner
    if (Test-McOwnedProcess $process) {
      Write-Output "$Name is already running on port $($instance.port)."
      return
    }
    throw "port $($instance.port) is held by pid $owner, which is not part of this repository. Stop it first; this script will not take the port over."
  }

  $saved = @{}
  $environment = @{
    NODE_ENV = if ($instance.mode -eq 'start') { 'production' } else { 'development' }
    PORT = "$($instance.port)"
    MOBILECLOUD_REALTIME_PORT = "$($instance.realtime)"
    MOBILECLOUD_NEXT_DIST_DIR = $instance.dist
    MOBILECLOUD_DB = $instance.database
    MOBILECLOUD_DATA_ROOT = $instance.dataRoot
    MOBILECLOUD_BOOTSTRAP_EMAIL = $instance.bootstrapEmail
    MOBILECLOUD_BOOTSTRAP_PASSWORD = $instance.bootstrapPassword
    MOBILECLOUD_WEB_HOST = '127.0.0.1'
  }
  if ($instance.publicOrigin) {
    $environment['MOBILECLOUD_PUBLIC_ORIGIN'] = $instance.publicOrigin
    $environment['MOBILECLOUD_ISSUER'] = $instance.publicOrigin
  }

  foreach ($key in $environment.Keys) {
    $saved[$key] = [Environment]::GetEnvironmentVariable($key)
    [Environment]::SetEnvironmentVariable($key, $environment[$key])
  }
  try {
    # The repository path contains a space, so the script argument is quoted:
    # `Start-Process` does not quote an argument that contains one.
    $entry = Join-Path $script:McApp 'server/run.mjs'
    $process = Start-Process -FilePath $script:McNode `
      -ArgumentList @("`"$entry`"", $instance.mode) `
      -WorkingDirectory $script:McApp `
      -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput (Join-Path $script:McLogs "$Name-console.out.log") `
      -RedirectStandardError (Join-Path $script:McLogs "$Name-console.err.log")
    Write-Output "$Name started (pid $($process.Id)) on port $($instance.port), build $($instance.dist), database $($instance.database)"
  } catch {
    Write-Output "$Name failed to start: $($_.Exception.Message)"
  } finally {
    foreach ($key in $saved.Keys) { [Environment]::SetEnvironmentVariable($key, $saved[$key]) }
  }
}

function Test-McDashboardAssets {
  <#
    .SYNOPSIS
      Fetches a dashboard and every `/_next/static` asset it references.

    .DESCRIPTION
      A dashboard that answers 200 is not proof that it works: a clobbered
      build directory still serves HTML while its CSS and JavaScript 404. This
      check reports the HTML status, the asset count and any asset that fails.
  #>
  param([string] $BaseUrl)

  $result = [ordered]@{
    url = $BaseUrl
    htmlStatus = $null
    assets = 0
    failedAssets = @()
    error = $null
  }
  try {
    $response = Invoke-WebRequest -Uri $BaseUrl -UseBasicParsing -TimeoutSec 30
    $result.htmlStatus = $response.StatusCode
    # Asset references carry a cache-busting query string and, in the app
    # router, parentheses in the route: `app/(console)/layout.js`.
    $matches = [regex]::Matches($response.Content, '/_next/static/[^\s"''<>\\]+')
    $assets = @($matches.Value | ForEach-Object { $_.TrimEnd('\', '"') } | Select-Object -Unique)
    $result.assets = $assets.Count
    foreach ($asset in $assets) {
      try {
        $assetResponse = Invoke-WebRequest -Uri "$BaseUrl$asset" -UseBasicParsing -TimeoutSec 30 -Method Head
        if ($assetResponse.StatusCode -ne 200) { $result.failedAssets += "$asset -> $($assetResponse.StatusCode)" }
      } catch {
        $status = $_.Exception.Response.StatusCode.value__
        $result.failedAssets += "$asset -> $status"
      }
    }
  } catch {
    $result.error = $_.Exception.Message
  }
  return $result
}
