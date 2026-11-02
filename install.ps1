# Flywheel bootstrap installer for Windows.
#
# It resolves one immutable release tag, downloads only from that tag, proves
# the archive is the published one, admits every archive entry before a byte is
# extracted, extracts into a private directory, proves the extracted tree
# again, and hands over to the archive's own installer. The installation
# itself belongs to the binary (ARCH-DISTRIBUTION-014); this script only gets a proved
# payload onto the disk.
$ErrorActionPreference = "Stop"

$Repo = if ($env:FLYWHEEL_REPO) { $env:FLYWHEEL_REPO } else { "wsauret/flywheel" }
$Version = if ($env:FLYWHEEL_VERSION) { $env:FLYWHEEL_VERSION } else { "latest" }

# The release origin is stated here and nowhere else. Every request, and every
# redirect hop before it is requested, must name this scheme and one of these
# authorities, so no answer can move a download to another origin, downgrade
# it to another scheme, carry credentials, or name another port. None of these
# authorities states a port, so only the scheme's default port is reachable.
$OriginScheme = "https"
$OriginAuthority = "github.com"
$AssetAuthorities = @("objects.githubusercontent.com", "objects-origin.githubusercontent.com", "release-assets.githubusercontent.com")
$MaxRedirects = 5
$GitHub = "$($OriginScheme)://$OriginAuthority"

# A build archive is a few thousand files, one of which is a large executable.
# These bounds are release-side: a person downloads this installer fresh from
# the release it installs, so the release that ships an archive also ships
# the bounds that admit it. They match RELEASE_BOUNDS in
# scripts/release-acceptance.ts, which refuses to publish an archive past
# them. The installed updater sets no bound of its own (ARCH-DISTRIBUTION-008).
$MaxEntries = 4096
$MaxFileBytes = 536870912
$MaxTotalBytes = 1073741824
# The compressed download is bounded on its own, so no server can write more
# than this to the disk whatever its listing later claims. It is the release's
# archive bound (RELEASE_BOUNDS.archiveBytes in scripts/release-acceptance.ts).
$MaxArchiveBytes = 536870912
$MaxChecksumsBytes = 1048576
# The release page is read for one thing only: the tag its redirect states.
$MaxPageBytes = 8388608
# Every request is bounded twice: a deadline to connect, and a deadline for
# each read of the body. A silent or a slow server cannot hold an install open.
$ConnectTimeoutSeconds = 15
$RequestTimeoutSeconds = 600
$ResolveTimeoutSeconds = 60

function Fail($Message) {
  Write-Error "flywheel install: $Message"
  exit 1
}

if ($Repo -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?/[A-Za-z0-9._-]{1,100}$' -or ($Repo -split '/')[-1] -in '.', '..') {
  Fail "the repository must be exactly one GitHub owner and repository"
}

# Windows PowerShell defaults to a TLS version github.com refuses.
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
  # A host whose runtime states one protocol has nothing to widen.
}

# Judges one hop before it is requested. A hop is a URL an answer chose, so it
# is held to the origin this script states: the scheme, an authority that is
# either the repository's origin or a host GitHub redirects release assets to,
# no credentials, no dot segment, and, for the origin, a path inside this
# repository's releases. Asset hosts serve opaque signed paths, so only their
# authority is judged.
function Assert-AllowedUrl($Url, $Label) {
  $uri = $null
  if (-not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$uri)) {
    Fail "$Label names $Url, which is not a whole location"
  }
  if ($uri.Scheme -ne $OriginScheme) { Fail "$Label names $Url, which is not $OriginScheme" }
  if ($uri.UserInfo) { Fail "$Label names $Url, which carries credentials" }
  if ($uri.AbsolutePath -match '(^|/)\.\.(/|$)') { Fail "$Label names $Url, which holds a dot segment" }
  $authority = $uri.Authority.ToLowerInvariant()
  if ($AssetAuthorities -contains $authority) { return }
  if ($authority -ne $OriginAuthority.ToLowerInvariant()) {
    Fail "$Label names $Url, whose host is not one this install may request"
  }
  if (-not $uri.AbsolutePath.StartsWith("/$Repo/releases/")) {
    Fail "$Label names $Url, which is outside the releases of $Repo"
  }
}

function Resolve-Location($Base, $Location, $Label) {
  if ($Location.StartsWith("/")) {
    $uri = [Uri]$Base
    return "$($uri.Scheme)://$($uri.Authority)$Location"
  }
  if ($Location -match '^[A-Za-z][A-Za-z0-9+.-]*://') { return $Location }
  Fail "$Label redirected to $Location, which is not a whole location"
}

function Remove-Partial($Path) {
  Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
}

# The body of one answer, written as it arrives. A server that states no length
# is bounded here instead: the count is kept as the bytes are read, and the
# read stops on the chunk that passes the cap, so no more than one buffer over
# the cap is ever held and nothing over it is written. What was written before
# the refusal is removed, so no partial download is left to be read as whole.
function Write-Body($Response, $Destination, $MaxBytes) {
  $buffer = New-Object byte[] 65536
  [long]$total = 0
  $failure = $null
  $reader = $Response.GetResponseStream()
  $writer = [System.IO.File]::Create($Destination)
  try {
    while ($true) {
      $read = $reader.Read($buffer, 0, $buffer.Length)
      if ($read -le 0) { break }
      $total += $read
      if ($total -gt $MaxBytes) {
        $failure = @{ Message = "it answered with more than the $MaxBytes bytes allowed" }
        break
      }
      $writer.Write($buffer, 0, $read)
      if ($Destination -eq $script:ArchivePath -and -not [Console]::IsErrorRedirected -and $Response.ContentLength -gt 0) {
        Write-Progress -Activity "Downloading Flywheel" -PercentComplete ([Math]::Min(100, [int](100 * $total / $Response.ContentLength)))
      }
    }
  } catch {
    $failure = @{ Retry = $true; Message = "its body ended early: $($_.Exception.Message)" }
  } finally {
    $writer.Dispose()
    $reader.Dispose()
    if ($Destination -eq $script:ArchivePath -and -not [Console]::IsErrorRedirected) {
      Write-Progress -Activity "Downloading Flywheel" -Completed
    }
  }
  if ($failure) {
    Remove-Partial $Destination
    return $failure
  }
  return @{ Ok = $true }
}

# One request, and no redirect: this host is told to follow none, so the answer
# is returned as it is and the hop it states is judged by the caller before it
# is requested. A length the server states over the cap is refused before the
# body is read at all.
function Read-Hop($Url, $Destination, $MaxBytes, $TimeoutSeconds) {
  $request = [System.Net.WebRequest]::Create($Url)
  $request.AllowAutoRedirect = $false
  $request.Timeout = $ConnectTimeoutSeconds * 1000
  $request.ReadWriteTimeout = $TimeoutSeconds * 1000
  $request.UserAgent = "flywheel-bootstrap-installer"
  $response = $null
  try {
    $response = $request.GetResponse()
  } catch {
    return @{ Retry = $true; Message = "it could not be reached: $($_.Exception.Message)" }
  }
  try {
    $status = [int]$response.StatusCode
    if ($status -ge 300 -and $status -lt 400) {
      $location = $response.Headers["Location"]
      if (-not $location) { return @{ Message = "it redirected without stating where" } }
      return @{ Redirect = $location }
    }
    if ($status -ne 200) { return @{ Message = "it answered with status $status" } }
    if ($response.ContentLength -gt $MaxBytes) {
      return @{ Message = "it states $($response.ContentLength) bytes, more than the $MaxBytes allowed" }
    }
    return Write-Body $response $Destination $MaxBytes
  } finally {
    $response.Close()
  }
}

# Downloads one URL and follows its redirects by hand. A refusal is a refusal,
# so only a transport fault is retried; the hop and the size judgements sit
# outside the retry. The URL that answered is returned.
function Download($Url, $Destination, $MaxBytes, $TimeoutSeconds, $Label) {
  $attempts = 3
  for ($attempt = 1; $attempt -le $attempts; $attempt++) {
    $current = $Url
    $retry = $false
    for ($hop = 0; $hop -le $MaxRedirects; $hop++) {
      Assert-AllowedUrl $current $Label
      $outcome = Read-Hop $current $Destination $MaxBytes $TimeoutSeconds
      if ($outcome.Ok) { return $current }
      if ($outcome.Redirect) {
        $current = Resolve-Location $current $outcome.Redirect $Label
        continue
      }
      if ($outcome.Retry -and $attempt -lt $attempts) {
        $retry = $true
        break
      }
      Fail "$Label could not be downloaded: $($outcome.Message)"
    }
    if (-not $retry) { Fail "$Label redirected more than the $MaxRedirects times allowed" }
    Start-Sleep -Seconds $attempt
  }
  Fail "$Label could not be downloaded"
}

# One resolution, one tag. `latest` moves, so it is read exactly once and every
# later request names the tag it resolved to.
function Resolve-LatestTag($Repo, $Scratch) {
  $page = Join-Path $Scratch "release-page"
  $final = Download "$GitHub/$Repo/releases/latest" $page $MaxPageBytes $ResolveTimeoutSeconds "the latest release of $Repo"
  Remove-Partial $page
  $uri = [Uri]$final
  if (-not $uri.AbsolutePath.StartsWith("/$Repo/releases/tag/")) {
    Fail "the latest release redirected outside $Repo"
  }
  return ($uri.AbsolutePath -split "/")[-1]
}

$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
  "AMD64" { "x64" }
  "ARM64" { "arm64" }
  default { Fail "unsupported CPU architecture: $env:PROCESSOR_ARCHITECTURE" }
}

$platform = "win32-$arch"
$asset = "flywheel-$platform.tar.gz"
$root = "flywheel-$platform"

# Windows ships its own archiver, and that is the one this uses. A `tar` found
# on PATH is whatever the machine happens to hold: a GNU tar from a Unix
# toolchain reads the `C:` in an absolute Windows path as a remote host and
# refuses every path this script gives it. Naming the archiver removes the
# question. A machine whose Windows predates the bundled archiver falls back to
# PATH, which is the only tar it has.
$Tar = Join-Path (Join-Path $env:SystemRoot "System32") "tar.exe"
if (-not (Test-Path -LiteralPath $Tar -PathType Leaf)) {
  $onPath = Get-Command tar -ErrorAction SilentlyContinue
  if (-not $onPath) { Fail "tar.exe is required to extract the release archive" }
  $Tar = $onPath.Source
}

$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("flywheel-install-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null

try {
  if ($Version -eq "latest") {
    $tag = Resolve-LatestTag $Repo $tmpDir
  } elseif ($Version.StartsWith("v")) {
    $tag = $Version
  } else {
    $tag = "v$Version"
  }

  if ($tag -notmatch '^v\d+\.\d+\.\d+$') { Fail "the release tag $tag is not a vMAJOR.MINOR.PATCH release" }
  $baseUrl = "$GitHub/$Repo/releases/download/$tag"

  $archivePath = Join-Path $tmpDir $asset
  $checksumsPath = Join-Path $tmpDir "SHASUMS256.txt"

  # The build the account runs now: the one the launcher's pointer names, or
  # the metadata a flat installation of an earlier release keeps beside its
  # executable. Remove the flat branch after 2026-12-28. Reading it only
  # informs the person, so what cannot be read says "unknown" and never stops
  # the installation.
  $accountHome = if ($env:HOME) { $env:HOME } else { $env:USERPROFILE }
  $installDir = if ($env:FLYWHEEL_INSTALL_DIR) { $env:FLYWHEEL_INSTALL_DIR } elseif ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "Flywheel\bin" } else { Join-Path $accountHome ".flywheel\bin" }
  try {
    $pointer = Join-Path $accountHome ".flywheel\current"
    $installedMetadata = Join-Path $installDir "build.json"
    if (Test-Path -LiteralPath $pointer -PathType Leaf) {
      $installedMetadata = Join-Path (Join-Path (Join-Path $accountHome ".flywheel") ([System.IO.File]::ReadAllText($pointer).Trim())) "build.json"
    }
    if (Test-Path -LiteralPath $installedMetadata -PathType Leaf) {
      $installedVersion = (Get-Content -LiteralPath $installedMetadata -Raw | ConvertFrom-Json).version
      if ($installedVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { $installedVersion = "unknown" }
      Write-Host "Installed version: $installedVersion"
    }
  } catch {
    Write-Host "Installed version: unknown"
  }
  Write-Host ""
  Write-Host "Installing flywheel version: $($tag.Substring(1))"
  Download "$baseUrl/$asset" $archivePath $MaxArchiveBytes $RequestTimeoutSeconds $asset | Out-Null
  Download "$baseUrl/SHASUMS256.txt" $checksumsPath $MaxChecksumsBytes $ResolveTimeoutSeconds "SHASUMS256.txt" | Out-Null

  $line = Get-Content $checksumsPath | Where-Object { $_ -match "\s+$([Regex]::Escape($asset))$" } | Select-Object -First 1
  if (-not $line) { Fail "$asset is missing from SHASUMS256.txt" }

  $expected = ($line -split "\s+")[0].ToLowerInvariant()
  $actual = (Get-FileHash -Algorithm SHA256 $archivePath).Hash.ToLowerInvariant()
  if ($actual -ne $expected) {
    Fail "checksum mismatch for $asset"
  }

  # Admission: every entry is judged on its name, on its type, and on the size
  # it states, while the archive is still only a listing. A build payload is a
  # plain tree of regular files and directories under one relative root, so an
  # absolute name, a dot component, a backslash, a repeated path, a link, a
  # device, a FIFO, or a socket is refused rather than extracted and inspected
  # afterwards.
  $names = @(& $Tar -tzf $archivePath)
  if ($LASTEXITCODE -ne 0) { Fail "$asset cannot be listed" }
  $verbose = @(& $Tar -tzvf $archivePath)
  if ($LASTEXITCODE -ne 0) { Fail "$asset cannot be listed" }
  if ($names.Count -eq 0) { Fail "$asset lists no entries" }
  if ($names.Count -ne $verbose.Count) { Fail "$asset lists entries that cannot be read one to a line" }
  if ($names.Count -gt $MaxEntries) { Fail "$asset lists $($names.Count) entries, more than the $MaxEntries allowed" }

  $seen = New-Object "System.Collections.Generic.HashSet[string]"
  [long]$statedBytes = 0
  for ($i = 0; $i -lt $names.Count; $i++) {
    $name = $names[$i]
    $entryType = $verbose[$i].Substring(0, 1)
    if ($entryType -ne "-" -and $entryType -ne "d") { Fail "$asset holds an entry that is not a regular file or a directory" }

    if ($name.Contains([char]0)) { Fail "$asset holds an entry name that holds a NUL byte" }
    if ($name -match '\\') { Fail "$asset holds an entry name that holds a backslash" }
    $normalized = if ($name.EndsWith("/")) { $name.Substring(0, $name.Length - 1) } else { $name }
    if ($normalized -match '^/' -or $normalized -match '^[A-Za-z]:') { Fail "$asset holds an entry name that is absolute" }
    foreach ($component in $normalized -split '/') {
      if ($component -eq "" -or $component -eq "." -or $component -eq "..") {
        Fail "$asset holds an entry name that holds a dot or an empty component"
      }
    }
    if ($normalized -ne $root -and -not $normalized.StartsWith("$root/")) {
      Fail "$asset holds $name, which is outside its $root root"
    }
    if (-not $seen.Add($normalized)) { Fail "$asset holds two entries that name one path" }

    # GNU tar prints owner and group as one field, bsdtar prints them as two,
    # so the stated size is field 3 or field 5.
    $fields = $verbose[$i] -split '\s+'
    $statedSize = if ($fields[1] -match '/') { $fields[2] } else { $fields[4] }
    if ($statedSize -notmatch '^\d+$') { Fail "$asset states a size for $normalized that is not a whole count of bytes" }
    [long]$size = [long]$statedSize
    if ($entryType -eq "d") {
      if ($size -ne 0) { Fail "$asset states $size bytes of content for the directory $normalized" }
    } else {
      if ($size -gt $MaxFileBytes) { Fail "$asset states $size bytes for $normalized, more than the $MaxFileBytes allowed for one file" }
      $statedBytes += $size
      if ($statedBytes -gt $MaxTotalBytes) { Fail "$asset states more than the $MaxTotalBytes bytes allowed for one archive" }
    }
  }

  & $Tar -xzf $archivePath -C $tmpDir
  if ($LASTEXITCODE -ne 0) { Fail "failed to extract $asset" }

  # The extracted tree is proved again, because admission judged what the
  # archive said it held and this judges what is actually on the disk.
  $extracted = Join-Path $tmpDir $root
  $entries = Get-ChildItem -LiteralPath $extracted -Recurse -Force
  foreach ($entry in $entries) {
    if ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
      Fail "$asset extracted a link, which a build payload never holds"
    }
  }
  $totalBytes = ($entries | Where-Object { -not $_.PSIsContainer } | Measure-Object -Property Length -Sum).Sum
  if ($totalBytes -gt $MaxTotalBytes) { Fail "$asset extracted more than the $MaxTotalBytes bytes allowed" }

  $installer = Join-Path $extracted "install.ps1"
  if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { Fail "the archive did not contain install.ps1" }

  & $installer -Downloaded
  if (-not $?) { exit 1 }
} finally {
  Remove-Item -Path $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
}

if (-not [Console]::IsOutputRedirected -and -not $env:NO_COLOR) {
  Write-Host ""
  Write-Host '█▀▀▀▀ █    █   █' -NoNewline -ForegroundColor DarkGray
  Write-Host ' █   █ █   █ █▀▀▀▀ █▀▀▀▀ █'
  Write-Host '█▄▄▄  █     ▀▄▀ ' -NoNewline -ForegroundColor DarkGray
  Write-Host ' █ ▄ █ █▄▄▄█ █▄▄▄  █▄▄▄  █'
  Write-Host '█     █      █  ' -NoNewline -ForegroundColor DarkGray
  Write-Host ' █ █ █ █   █ █     █     █'
  Write-Host '▀     ▀▀▀▀▀  ▀  ' -NoNewline -ForegroundColor DarkGray
  Write-Host '  ▀ ▀  ▀   ▀ ▀▀▀▀▀ ▀▀▀▀▀ ▀▀▀▀▀'
  Write-Host ""
} else {
  Write-Host ""
  Write-Host "Flywheel installed"
  Write-Host ""
}
Write-Host "To start:"
Write-Host ""
Write-Host "  cd <project>  # Open your project"
Write-Host "  flywheel      # Start Flywheel"
Write-Host ""
Write-Host "Installed. Open a new terminal and run: flywheel"
