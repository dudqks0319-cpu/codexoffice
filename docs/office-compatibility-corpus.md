# Office compatibility corpus

`npm run compat:libreoffice` round-trips three tracked OOXML fixtures through a
fresh, isolated LibreOffice headless profile and fails if core structural counts
change.

- DOCX: body footnote references, footnote records, and media.
- XLSX: sheet declarations, worksheet parts, charts, and media.
- PPTX: slide IDs, slide parts, masters, and media.

The command uses only a new OS temporary directory and removes it on exit. It
does not overwrite corpus files. This is a deterministic interoperability smoke
test, not proof of Microsoft Office fidelity. Before release, the same candidate
files still require manual open, edit, save, and reopen checks in supported
versions of Word, Excel, and PowerPoint, with screenshots and exact build IDs.
