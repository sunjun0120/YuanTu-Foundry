param(
  [Parameter(Mandatory = $true)][string]$Root,
  [switch]$Once
)
# Keeps a running batch's disk footprint bounded.
#
# Control certification copies the corpus (and its private dependency installation) once per variant, and nothing
# reads those trees again once verification.json exists: the verdict lives in the JSON beside it and in
# controls.json. Only already-certified copies of fully-finished cases are deleted, so this can never race a
# certification that is still in progress. Sample work trees are never touched — those hold the model's patch.
#
# A first acceptance run filled the volume because every workspace got its own ~600 MB installation; this is the
# knob that keeps a 10-case batch inside a normal disk.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File prune-batch-copies.ps1 -Root <batchRoot> [-Once]
while ($true) {
  $freed = 0
  if (Test-Path -LiteralPath $Root) {
    foreach ($batch in Get-ChildItem -LiteralPath $Root -Directory -ErrorAction SilentlyContinue) {
      $controls = Join-Path $batch.FullName 'controls'
      if (-not (Test-Path -LiteralPath $controls)) { continue }
      foreach ($case in Get-ChildItem -LiteralPath $controls -Directory -ErrorAction SilentlyContinue) {
        $variants = @(Get-ChildItem -LiteralPath $case.FullName -Directory -ErrorAction SilentlyContinue)
        if ($variants.Count -lt 3) { continue }
        $finished = @($variants | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'verification.json') })
        if ($finished.Count -lt 3) { continue }
        foreach ($variant in $finished) {
          foreach ($name in @('workspace', 'validation')) {
            $target = Join-Path $variant.FullName $name
            if (-not (Test-Path -LiteralPath $target)) { continue }
            $size = (Get-ChildItem -LiteralPath $target -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
            Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
            if (-not (Test-Path -LiteralPath $target)) { $freed = $freed + $size }
          }
        }
      }
    }
  }
  if ($freed -gt 0) {
    $freeGb = [math]::Round((Get-PSDrive E).Free / 1GB, 2)
    $freedMb = [math]::Round($freed / 1MB, 0)
    Write-Host "$(Get-Date -Format 'HH:mm:ss') freed $freedMb MB (E: free $freeGb GB)"
  }
  if ($Once) { break }
  Start-Sleep -Seconds 45
}
