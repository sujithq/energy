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
    & npm run sync:fluvius
  }
  finally {
    Pop-Location
  }

  if ($LASTEXITCODE -ne 0) {
    throw "The Fluvius refresh failed with exit code $LASTEXITCODE."
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
