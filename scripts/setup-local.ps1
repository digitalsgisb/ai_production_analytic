param(
  [string]$PostgresAdmin = "postgres",
  [string]$PsqlPath = "C:\Program Files\PostgreSQL\18\bin\psql.exe"
)

$ErrorActionPreference = "Stop"
$projectDirectory = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectDirectory

if (-not (Test-Path -LiteralPath $PsqlPath)) {
  throw "psql.exe was not found at $PsqlPath. Pass -PsqlPath with the installed location."
}

$securePassword = Read-Host "PostgreSQL password for $PostgresAdmin" -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
  $adminPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
}

$randomBytes = [byte[]]::new(32)
$randomGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $randomGenerator.GetBytes($randomBytes)
} finally {
  $randomGenerator.Dispose()
}
$assistantPassword = [Convert]::ToBase64String($randomBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')

try {
  $env:PGPASSWORD = $adminPassword
  & $PsqlPath --host 127.0.0.1 --port 5432 --username $PostgresAdmin --dbname postgres --set ON_ERROR_STOP=1 --file db/create-database.sql
  if ($LASTEXITCODE -ne 0) { throw "Could not create or inspect production_analytics." }
  & $PsqlPath --host 127.0.0.1 --port 5432 --username $PostgresAdmin --dbname production_analytics --set ON_ERROR_STOP=1 --set "assistant_password=$assistantPassword" --file db/provision-role.sql
  if ($LASTEXITCODE -ne 0) { throw "Could not provision assistant_app." }
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
  $adminPassword = $null
}

$encodedPassword = [Uri]::EscapeDataString($assistantPassword)
$environment = @"
NODE_ENV=development
PORT=3000
PUBLIC_ORIGIN=http://localhost:5173
DATABASE_URL=postgresql://assistant_app:${encodedPassword}@127.0.0.1:5432/production_analytics
LANGFLOW_BASE_URL=http://langflow.invalid:7860
LANGFLOW_FLOW_ID=local-preview
LANGFLOW_API_KEY=
LANGFLOW_MOCK=true
SESSION_TTL_HOURS=24
LANGFLOW_TIMEOUT_MS=600000
"@
[IO.File]::WriteAllText((Join-Path $projectDirectory ".env"), $environment, [Text.UTF8Encoding]::new($false))

Write-Host "Local PostgreSQL and .env are ready. Secrets were not printed."
Write-Host "Next: npm.cmd run db:migrate, then npm.cmd run admin:create, then npm.cmd run dev"
