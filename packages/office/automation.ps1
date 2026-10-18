$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
# An application still starting under COM can answer Open with no document and no error; the next line would
# then fail as a call on a null value, which names nothing. Ask again briefly, then say what actually happened.
function Open-WithRetry([scriptblock]$open, [string]$name) {
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    $opened = & $open
    # The comma keeps PowerShell from enumerating a COM object on its way out of the function.
    if ($opened) { return ,$opened }
    Start-Sleep -Milliseconds 500
  }
  throw "$name did not open the document (it returned no document after 3 attempts)"
}
$app = $null
$document = $null
try {
  # Creating and editing are built in JavaScript; this script only converts an existing file to PDF.
  if ($inputData.operation -ne 'preview') { throw 'Unsupported Office operation' }
  switch ([string]$inputData.format) {
    'docx' {
      $app = New-Object -ComObject Word.Application
      $app.Visible = $false
      $app.DisplayAlerts = 0
      $app.AutomationSecurity = 3
      $document = Open-WithRetry { $app.Documents.Open([string]$inputData.sourcePath, $false, $true, $false) } 'Word'
      $document.ExportAsFixedFormat([string]$inputData.outputPath, 17)
    }
    'pptx' {
      $app = New-Object -ComObject PowerPoint.Application
      $app.AutomationSecurity = 3
      $document = Open-WithRetry { $app.Presentations.Open([string]$inputData.sourcePath, $true, $false, $false) } 'PowerPoint'
      $document.SaveAs([string]$inputData.outputPath, 32)
    }
    default { throw 'Unsupported Office format' }
  }
  [Console]::Out.WriteLine('{"ok":true}')
} catch {
  [Console]::Error.WriteLine($_.Exception.Message + ' | ' + $_.ScriptStackTrace)
  exit 1
} finally {
  if ($document) {
    try {
      if ($inputData.format -eq 'docx') { $document.Close($false) }
      elseif ($inputData.format -eq 'xlsx') { $document.Close($false) }
      else { $document.Close() }
    } catch {}
    try { [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($document) | Out-Null } catch {}
  }
  if ($app) {
    try { $app.Quit() } catch {}
    try { [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($app) | Out-Null } catch {}
  }
}
