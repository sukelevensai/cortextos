# verify-password.ps1
# ---------------------------------------------------------------------------
# Non-destructively checks whether a password is your Windows ACCOUNT password,
# BEFORE you commit it to the session-0 task. Validation only -- it does not
# log you in, change anything, or create a session.
#
# RUN IN YOUR OWN PowerShell window (it prompts for the password securely):
#   & 'C:\Users\lukes\cortextos\scripts\verify-password.ps1'
#
# ASCII-only (PS 5.1 mis-decodes non-ASCII).
# ---------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'

Write-Host "=== Windows account password check ===" -ForegroundColor Cyan
Write-Host "Account: $env:USERDOMAIN\$env:USERNAME"
Write-Host ""
Write-Host "Account type: open Settings > Accounts > Your info." -ForegroundColor Gray
Write-Host "  - If it shows an EMAIL under your name => Microsoft account; the password is your" -ForegroundColor Gray
Write-Host "    Microsoft sign-in password (manage/reset at https://account.microsoft.com)." -ForegroundColor Gray
Write-Host "  - If it says 'Local account' => it's your local Windows password." -ForegroundColor Gray
Write-Host ""

Add-Type -AssemblyName System.DirectoryServices.AccountManagement
$ctx = New-Object System.DirectoryServices.AccountManagement.PrincipalContext('Machine')

$sec   = Read-Host "Type the password you want to test" -AsSecureString
$bstr  = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
$plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)

$ok = $false
try {
    $ok = $ctx.ValidateCredentials($env:USERNAME, $plain)
} catch {
    Write-Host "Validator error: $($_.Exception.Message)" -ForegroundColor Yellow
}
$plain = $null

Write-Host ""
if ($ok) {
    Write-Host "RESULT: PASSWORD VALID." -ForegroundColor Green
    Write-Host "Use this exact password at the session-0 task prompt." -ForegroundColor Green
} else {
    Write-Host "RESULT: REJECTED by the local validator." -ForegroundColor Red
    Write-Host "Either it's not the account password, OR it's a Microsoft account the local" -ForegroundColor Red
    Write-Host "validator cannot check. Reliable fallback to confirm WITHOUT lockout risk:" -ForegroundColor Red
    Write-Host "  1. Press Win+L to lock the screen." -ForegroundColor Gray
    Write-Host "  2. On the sign-in screen click 'Sign-in options' and pick the password (key) icon." -ForegroundColor Gray
    Write-Host "  3. Type the password. If it signs you in, that's the one the task needs." -ForegroundColor Gray
}
