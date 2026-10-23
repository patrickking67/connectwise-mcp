<#
.SYNOPSIS
    TEMPLATE - <Product> deploy payload for ConnectWise Automate Execute Script.
    Runs as SYSTEM (credential: Local Agent). PowerShell 5.1. ASCII only.
.DESCRIPTION
    Replace every TODO. Keep the structure: lock first, result file first in
    Fin, private work folder, unknown-is-not-absent detection, top-level catch.
.OUTPUTS
    Last line is always PRODUCT_RESULT=<code>. See payload-contract.md.
.PARAMETER Secret
    Automate substitutes the secret variable from the client EDF. Single quotes
    are deliberate. Leave Script Parameters EMPTY in the Execute Script row.
#>
#Requires -Version 5.1
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '')]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '', Justification = 'Non-interactive SYSTEM payload.')]
param(
    [string]$Secret     = '@secretvar@',                                   # TODO: rename the variable
    [string]$ResultFile = "$env:ProgramData\YourOrg\Product\last-result.txt" # TODO
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'
$Prefix      = 'PRODUCT'                       # TODO: PRODUCT_RESULT=
$DownloadUrl = 'https://vendor.example/agent.msi'   # TODO
$UpgradeCode = '{00000000-0000-0000-0000-000000000000}' # TODO: vendor UpgradeCode
$script:WorkDir = $null

function Fin {
    param([string]$Code, [int]$ExitCode, [string]$Message)
    $busy = ($Code -eq 'WARN_BUSY')
    if (-not $busy) { Write-ResultFile $Code }        # first, before any cleanup
    Write-Host $(if ($Code -like 'FAIL_*') { "ERROR: $Message" } elseif ($Code -like 'WARN_*') { "WARN: $Message" } else { $Message })
    if (-not $busy -and $script:WorkDir) {
        Remove-Item -LiteralPath $script:WorkDir -Recurse -Force -ErrorAction SilentlyContinue  # TODO: keep a redacted log on FAIL_
    }
    Write-Host "${Prefix}_RESULT=$Code"
    if ($Code -like 'FAIL_*') { exit $ExitCode } else { exit 0 }
}

function Write-ResultFile([string]$Code) {
    try {
        $dir = Split-Path -Parent $ResultFile
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        [IO.File]::WriteAllText($ResultFile, $Code, (New-Object Text.UTF8Encoding($false)))
    } catch { Write-Host "ERROR: could not write $ResultFile, Automate will record NO_RESULT" }
}

function New-PrivateWorkDir {
    $sec = New-Object System.Security.AccessControl.DirectorySecurity
    $sec.SetAccessRuleProtection($true, $false)
    foreach ($sid in 'S-1-5-18', 'S-1-5-32-544') {
        $sec.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
            (New-Object Security.Principal.SecurityIdentifier($sid)), 'FullControl',
            'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    }
    $path = Join-Path $env:TEMP ('dit-' + [guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($path, $sec)
    return $path
}

# "" = not installed; $null = could not tell (never treat as not installed)
function Get-InstalledVersion {
    try {
        $i = New-Object -ComObject WindowsInstaller.Installer
        $rel = $i.RelatedProducts($UpgradeCode)
        if ($rel.Count -eq 0) { return '' }
        return [string]$i.ProductInfo($rel.Item(0), 'VersionString')
    } catch { return $null }
}

try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not ($id.IsSystem -or (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole('Administrators'))) {
        Fin 'FAIL_PRIVILEGE' 5 'Not elevated; set the Execute Script credential to Local Agent.'
    }

    $mutex = New-Object System.Threading.Mutex($false, 'Global\YourOrg-ProductDeploy')   # TODO
    try { $have = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $have = $true }
    if (-not $have) { Fin 'WARN_BUSY' 0 'Another run is active; took no action.' }
    Remove-Item -LiteralPath $ResultFile -Force -ErrorAction SilentlyContinue

    $sentinel = [string][char]64 + 'secretvar' + [string][char]64             # TODO: match the variable name
    if ([string]::IsNullOrWhiteSpace($Secret) -or $Secret -eq $sentinel) { Fin 'FAIL_TOKEN' 1 'Secret empty or not substituted.' }
    $Secret = $Secret.Trim()
    if ($Secret -notmatch '^[0-9a-fA-F]{32,128}$') { Fin 'FAIL_TOKEN' 1 'Secret malformed.' }   # TODO: real format

    $v = Get-InstalledVersion
    if ($null -eq $v) { Fin 'FAIL_DETECT' 6 'Could not query installed products; took no action.' }
    if ($v) { Fin 'OK_ENROLLED' 0 "Already installed ($v). No action." }       # TODO: registration state

    $script:WorkDir = New-PrivateWorkDir
    $msi = Join-Path $script:WorkDir 'agent.msi'
    $log = Join-Path $script:WorkDir 'install.log'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    try { Invoke-WebRequest -Uri $DownloadUrl -OutFile $msi -UseBasicParsing -TimeoutSec 300 }
    catch { Fin 'FAIL_DOWNLOAD' 2 "Download failed: $($_.Exception.Message)" }
    # TODO: size floor, OLE magic D0CF11E0A1B11AE1, UpgradeCode match

    $psi = New-Object Diagnostics.ProcessStartInfo -ArgumentList 'msiexec.exe'
    $psi.Arguments = "/i `"$msi`" /qn /norestart /L* `"$log`" MsiHiddenProperties=SECRET_PROP SECRET_PROP=`"$Secret`""  # TODO; the regex must exclude spaces and quotes
    $psi.UseShellExecute = $false
    $p = [Diagnostics.Process]::Start($psi); $p.WaitForExit(); $rc = $p.ExitCode; $p.Dispose()
    if ($rc -notin 0, 3010, 1641) { Fin 'FAIL_INSTALL' 3 "msiexec exit $rc." }  # TODO: 1618 retry, redacted log

    if (-not (Get-InstalledVersion)) { Fin 'FAIL_VERIFY' 4 'msiexec succeeded but nothing is registered.' }
    Fin 'OK_INSTALLED' 0 'Installed.'
} catch {
    Fin 'FAIL_UNHANDLED' 7 "Unexpected error at line $($_.InvocationInfo.ScriptLineNumber): $($_.Exception.Message)"
}
