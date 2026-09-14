param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Executable,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Arguments
)

$ErrorActionPreference = "Stop"
& $Executable @Arguments
exit $LASTEXITCODE

