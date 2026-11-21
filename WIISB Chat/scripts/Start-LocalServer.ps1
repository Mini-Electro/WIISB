$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $project
$env:DATA_DIR = Join-Path $project '.data'
$env:DOTENV_CONFIG_PATH = Join-Path $project '.env'
& node (Join-Path $project 'apps\server\dist\main.js')
