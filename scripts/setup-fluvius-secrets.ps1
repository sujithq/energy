[CmdletBinding()]
param(
  [string]$SecretFile = (Join-Path $HOME ".fluvius\secrets.xml")
)

$ErrorActionPreference = "Stop"
$directory = Split-Path -Parent $SecretFile
New-Item -ItemType Directory -Path $directory -Force | Out-Null

$detailUrl = Read-Host "Fluvius meter detail URL (https://mijn.fluvius.be/verbruik/<EAN>/detail)"
if ([string]::IsNullOrWhiteSpace($detailUrl)) {
  throw "A Fluvius meter detail URL is required."
}

$credential = Get-Credential -Message "Enter the existing personal Mijn Fluvius credentials."
if ($null -eq $credential -or $null -eq $credential.Password) {
  throw "A Fluvius credential is required."
}

$meterSerial = Read-Host "Fluvius meter serial number" -AsSecureString
if ($null -eq $meterSerial -or $meterSerial.Length -eq 0) {
  throw "A Fluvius meter serial number is required for browserless refreshes."
}

[pscustomobject]@{
  Credential = $credential
  DetailUrl = ConvertTo-SecureString $detailUrl -AsPlainText -Force
  MeterSerial = $meterSerial
} | Export-Clixml -LiteralPath $SecretFile

Write-Host "Fluvius credentials and meter configuration saved for this Windows user at $SecretFile."
