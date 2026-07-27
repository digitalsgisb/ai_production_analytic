param(
  [string]$PostgresAdmin = "postgres",
  [string]$PostgresService = "postgresql-x64-18",
  [string]$PostgresData = "C:\Program Files\PostgreSQL\18\data",
  [string]$PsqlPath = "C:\Program Files\PostgreSQL\18\bin\psql.exe"
)

$ErrorActionPreference = "Stop"
if ($PostgresAdmin -notmatch '^[A-Za-z_][A-Za-z0-9_-]{0,62}$') {
  throw "PostgresAdmin contains unsupported characters."
}
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Open PowerShell with 'Run as administrator', return to the project folder, and run this script again."
}

$hbaPath = Join-Path $PostgresData "pg_hba.conf"
if (-not (Test-Path -LiteralPath $hbaPath)) { throw "pg_hba.conf was not found at $hbaPath." }
if (-not (Test-Path -LiteralPath $PsqlPath)) { throw "psql.exe was not found at $PsqlPath." }

$newPasswordSecure = Read-Host "New PostgreSQL password for $PostgresAdmin" -AsSecureString
$confirmPasswordSecure = Read-Host "Confirm the new password" -AsSecureString

function Convert-SecureStringToPlain([Security.SecureString]$Value) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

$newPassword = Convert-SecureStringToPlain $newPasswordSecure
$confirmPassword = Convert-SecureStringToPlain $confirmPasswordSecure
if ($newPassword -cne $confirmPassword) { throw "The two passwords did not match." }
if ($newPassword.Length -lt 16) { throw "Use at least 16 characters for the PostgreSQL administrator password." }

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupPath = "$hbaPath.sugi-backup-$stamp"
$original = [IO.File]::ReadAllText($hbaPath)
$pattern = '(?m)^(\s*host\s+all\s+all\s+(?:127\.0\.0\.1/32|::1/128)\s+)\S+(.*)$'
$temporary = [Text.RegularExpressions.Regex]::Replace($original, $pattern, '${1}trust${2}')
if ($temporary -eq $original) {
  throw "The standard localhost authentication rules were not found. No PostgreSQL configuration was changed."
}

Copy-Item -LiteralPath $hbaPath -Destination $backupPath
try {
  [IO.File]::WriteAllText($hbaPath, $temporary, [Text.UTF8Encoding]::new($false))
  Restart-Service -Name $PostgresService

  $escapedPassword = $newPassword.Replace("'", "''")
  $sql = "ALTER ROLE `"$PostgresAdmin`" PASSWORD '$escapedPassword';"
  $sql | & $PsqlPath --host 127.0.0.1 --port 5432 --username $PostgresAdmin --dbname postgres --no-password --set ON_ERROR_STOP=1
  if ($LASTEXITCODE -ne 0) { throw "PostgreSQL did not accept the password reset." }
} finally {
  [IO.File]::WriteAllText($hbaPath, $original, [Text.UTF8Encoding]::new($false))
  Restart-Service -Name $PostgresService
  $newPassword = $null
  $confirmPassword = $null
  $escapedPassword = $null
  $sql = $null
}

Write-Host "The PostgreSQL password was reset and secure authentication was restored."
Write-Host "Safety backup: $backupPath"
