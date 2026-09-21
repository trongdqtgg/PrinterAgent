param(
  [Parameter(Mandatory=$true)][string]$InputPath,
  [Parameter(Mandatory=$true)][string]$OutputPath,
  [Parameter(Mandatory=$true)][ValidateSet('word','excel')][string]$Type
)
$ErrorActionPreference = 'Stop'
if ($Type -eq 'word') {
  $app = New-Object -ComObject Word.Application
  $app.Visible = $false
  try {
    $doc = $app.Documents.Open($InputPath, $false, $true)
    try { $doc.ExportAsFixedFormat($OutputPath, 17) } finally { $doc.Close($false) }
  } finally { $app.Quit() }
} else {
  $app = New-Object -ComObject Excel.Application
  $app.Visible = $false
  $app.DisplayAlerts = $false
  try {
    $book = $app.Workbooks.Open($InputPath, 0, $true)
    try { $book.ExportAsFixedFormat(0, $OutputPath) } finally { $book.Close($false) }
  } finally { $app.Quit() }
}
