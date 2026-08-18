[CmdletBinding()]
param(
  [string]$DetailUrl = $env:FLUVIUS_DETAIL_URL,
  [string]$FromDate = $env:FLUVIUS_FROM_DATE,
  [string]$ThroughDate = $env:FLUVIUS_THROUGH_DATE,
  [string]$SecretFile = (Join-Path $HOME ".fluvius\secrets.xml")
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$environmentNames = @(
  "FLUVIUS_EMAIL",
  "FLUVIUS_PASSWORD",
  "FLUVIUS_DETAIL_URL",
  "FLUVIUS_FROM_DATE",
  "FLUVIUS_THROUGH_DATE"
)
$originalEnvironment = @{}
foreach ($name in $environmentNames) {
  $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

function Test-GitPathModified {
  param([Parameter(Mandatory)] [string]$Path)

  & git diff --quiet HEAD -- $Path
  switch ($LASTEXITCODE) {
    0 { return $false }
    1 { return $true }
    default { throw "Git could not inspect $Path." }
  }
}

function Publish-GridSupplement {
  param([Parameter(Mandatory)] [string]$Path)

  if (-not (Test-GitPathModified $Path)) {
    Write-Host "The sanitized supplement is already current."
    return
  }

  & git add -- $Path
  if ($LASTEXITCODE -ne 0) {
    throw "Git could not stage $Path."
  }

  & git commit --only -m "chore(data): refresh Fluvius grid supplement" -- $Path
  if ($LASTEXITCODE -ne 0) {
    throw "Git could not commit $Path."
  }

  $branch = (& git branch --show-current).Trim()
  if ([string]::IsNullOrWhiteSpace($branch)) {
    throw "The Fluvius supplement commit was created locally, but the current Git branch could not be identified."
  }

  & git push origin "HEAD:$branch"
  if ($LASTEXITCODE -ne 0) {
    throw "The Fluvius supplement commit was created locally, but Git could not push it to origin."
  }

  Write-Host "Committed and pushed the refreshed Fluvius grid supplement."
}

$secret = $null
if (Test-Path -LiteralPath $SecretFile) {
  $secret = Import-Clixml -LiteralPath $SecretFile
  if ([string]::IsNullOrWhiteSpace($DetailUrl) -and $secret.DetailUrl) {
    $detailUrlPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret.DetailUrl)
    try {
      $DetailUrl = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($detailUrlPointer)
    }
    finally {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($detailUrlPointer)
    }
  }
  $credential = $secret.Credential
} else {
  if ([string]::IsNullOrWhiteSpace($DetailUrl)) {
    $DetailUrl = Read-Host "Fluvius meter detail URL (https://mijn.fluvius.be/verbruik/<EAN>/detail)"
  }
  $credential = Get-Credential -Message "Enter the existing personal Mijn Fluvius credentials."
}

if ([string]::IsNullOrWhiteSpace($DetailUrl)) {
  throw "A Fluvius meter detail URL is required."
}
if ($null -eq $credential -or $null -eq $credential.Password) {
  throw "A Fluvius credential is required."
}

$passwordPointer = [IntPtr]::Zero

try {
  $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($credential.Password)
  $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)

  $env:FLUVIUS_EMAIL = $credential.UserName
  $env:FLUVIUS_PASSWORD = $password
  $env:FLUVIUS_DETAIL_URL = $DetailUrl

  if ([string]::IsNullOrWhiteSpace($FromDate)) {
    Remove-Item Env:FLUVIUS_FROM_DATE -ErrorAction SilentlyContinue
  } else {
    $env:FLUVIUS_FROM_DATE = $FromDate
  }

  if ([string]::IsNullOrWhiteSpace($ThroughDate)) {
    Remove-Item Env:FLUVIUS_THROUGH_DATE -ErrorAction SilentlyContinue
  } else {
    $env:FLUVIUS_THROUGH_DATE = $ThroughDate
  }

  Push-Location $repositoryRoot
  try {
    if (Test-GitPathModified "data/grid-supplement.json") {
      throw "data/grid-supplement.json has changes before the Fluvius refresh. Refusing to commit an existing change."
    }

    & npm run sync:fluvius
    if ($LASTEXITCODE -ne 0) {
      throw "The Fluvius refresh failed with exit code $LASTEXITCODE."
    }

    Publish-GridSupplement "data/grid-supplement.json"
  }
  finally {
    Pop-Location
  }
}
finally {
  if ($passwordPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
  }

  foreach ($name in $environmentNames) {
    $value = $originalEnvironment[$name]
    if ($null -eq $value) {
      Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    } else {
      [Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
  }
}
