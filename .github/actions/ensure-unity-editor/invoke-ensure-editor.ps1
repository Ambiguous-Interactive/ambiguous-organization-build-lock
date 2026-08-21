#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ValidatorPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $ValidatorPath -PathType Leaf)) {
    throw 'The trusted Unity editor validator payload is missing.'
}
if ([string]::IsNullOrWhiteSpace($env:ENSURE_UNITY_EDITOR_CONFIG_B64)) {
    throw 'The Unity editor validator configuration is missing.'
}

$encodedConfiguration = $env:ENSURE_UNITY_EDITOR_CONFIG_B64
Remove-Item Env:ENSURE_UNITY_EDITOR_CONFIG_B64
$configurationJson = [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String($encodedConfiguration)
)
$configuration = $configurationJson | ConvertFrom-Json
$parameters = @{
    UnityVersion = [string]$configuration.unityVersion
}

if ($null -ne $configuration.installRoot) {
    $parameters.InstallRoot = [string]$configuration.installRoot
}
if ($null -ne $configuration.provisioningProfile) {
    $parameters.ProvisioningProfile = [string]$configuration.provisioningProfile
}
if ($null -ne $configuration.diagnosticsPath) {
    $parameters.DiagnosticsPath = [string]$configuration.diagnosticsPath
}
if ($null -ne $configuration.ciManagedOnly) {
    $parameters.CiManagedOnly = [bool]$configuration.ciManagedOnly
}
if ($null -ne $configuration.requireHealthyExisting) {
    $parameters.RequireHealthyExisting = [bool]$configuration.requireHealthyExisting
}
if ($null -ne $configuration.withWindowsIl2Cpp) {
    $parameters.WithWindowsIl2Cpp = [bool]$configuration.withWindowsIl2Cpp
}
$requiredPayload = @($configuration.requiredEditorPayloadRelativePath)
if ($requiredPayload.Count -gt 0) {
    $parameters.RequiredEditorPayloadRelativePath = [string[]]$requiredPayload
}

& $ValidatorPath @parameters
