$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
$app = $null
$document = $null
try {
  switch ([string]$inputData.format) {
    'docx' {
      $app = New-Object -ComObject Word.Application
      $app.Visible = $false
      $app.DisplayAlerts = 0
      $app.AutomationSecurity = 3
      if ($inputData.operation -eq 'create') {
        $document = $app.Documents.Add()
        $selection = $app.Selection
        if ($inputData.title) {
          $selection.Style = -63
          $selection.TypeText([string]$inputData.title)
          $selection.TypeParagraph()
        }
        $selection.Style = -1
        foreach ($paragraph in @($inputData.paragraphs)) {
          $selection.TypeText([string]$paragraph)
          $selection.TypeParagraph()
        }
        $document.SaveAs2([string]$inputData.outputPath, 16)
      } else {
        $readOnly = $inputData.operation -eq 'preview'
        $document = $app.Documents.Open([string]$inputData.sourcePath, $false, $readOnly, $false)
        if ($inputData.operation -eq 'edit') {
          foreach ($replacement in @($inputData.replacements)) {
            $find = $document.Content.Find
            $found = $find.Execute([string]$replacement.from, $false, $false, $false,
              $false, $false, $true, 1, $false, [string]$replacement.to, 2)
            if (-not $found) { throw "Word text not found: $($replacement.from)" }
          }
          $document.SaveAs2([string]$inputData.outputPath, 16)
        } elseif ($inputData.operation -eq 'preview') {
          $document.ExportAsFixedFormat([string]$inputData.outputPath, 17)
        } else { throw 'Unsupported Word operation' }
      }
    }
    'pptx' {
      $app = New-Object -ComObject PowerPoint.Application
      $app.AutomationSecurity = 3
      if ($inputData.operation -eq 'create') {
        $document = $app.Presentations.Add($false)
        $slideNumber = 1
        foreach ($slideData in @($inputData.slides)) {
          $slide = $document.Slides.Add($slideNumber, 2)
          $slide.Shapes.Title.TextFrame.TextRange.Text = [string]$slideData.title
          $slide.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text =
            (@($slideData.body) | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
          $slideNumber++
        }
        $document.SaveAs([string]$inputData.outputPath, 24)
      } else {
        $readOnly = $inputData.operation -eq 'preview'
        $document = $app.Presentations.Open([string]$inputData.sourcePath, $readOnly, $false, $false)
        if ($inputData.operation -eq 'edit') {
          foreach ($replacement in @($inputData.replacements)) {
            $found = $false
            foreach ($slide in @($document.Slides)) {
              foreach ($shape in @($slide.Shapes)) {
                if ($shape.HasTextFrame -and $shape.TextFrame.HasText) {
                  $range = $shape.TextFrame.TextRange
                  if ($range.Text.Contains([string]$replacement.from)) {
                    $range.Text = $range.Text.Replace([string]$replacement.from, [string]$replacement.to)
                    $found = $true
                  }
                }
              }
            }
            if (-not $found) { throw "PowerPoint text not found: $($replacement.from)" }
          }
          $document.SaveAs([string]$inputData.outputPath, 24)
        } elseif ($inputData.operation -eq 'preview') {
          $document.SaveAs([string]$inputData.outputPath, 32)
        } else { throw 'Unsupported PowerPoint operation' }
      }
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
