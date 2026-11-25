# Energy Invoice Dashboard Copilot extension

This directory contains the reusable, project-scoped Energy Invoice Dashboard
extension. Opening a clone of this repository lets Copilot discover the public
canvas code. The canvas is separate from the browser dashboard and is not
included in the GitHub Pages site.

## Privacy boundary

The following code is intentionally tracked and can be backed up publicly:

- `extension.mjs`
- `invoice-parser.mjs`
- `renderer.html`
- `artifacts/.gitignore`
- this README

Personal runtime data stays local under `artifacts/`:

- `artifacts/ledger.json` contains derived invoice metadata.
- `artifacts/invoices/` contains the original invoice PDFs.

`artifacts/.gitignore` ignores everything in that directory except the
`.gitignore` itself. Never force-add ignored files. Do not put invoice PDFs,
ledger JSON, EANs, addresses, customer or invoice numbers, invoice filenames,
or extracted invoice text in any tracked file, issue, public fixture, gist, or
repository artifact.

The extension resolves `artifacts/` relative to its own `extension.mjs`, so
each clone or Git worktree has a separate private store. A user-installed copy
and this project extension may both be discovered and named **Energy invoice
dashboard**, but their IDs and data stores differ. In this repository, use the
project extension; copying this repository's code does not move or expose the
user-installed extension's data.

GitHub backs up the reusable extension code, not the ignored PDFs or derived
ledger. Back those files up separately in a private location and restore them
manually after cloning.

## Requirements

The Copilot host supplies `@github/copilot-sdk`; do not install it as a project
dependency. Parsing uploaded invoices also requires `pdftotext` on `PATH`.

## Restore local data

On a fresh clone, the tracked code is restored but the personal `artifacts/`
data is not. Create the local invoice directory, then copy the saved files into
the project extension:

```powershell
New-Item -ItemType Directory -Force `
  .github\extensions\energy-invoice-dashboard\artifacts\invoices | Out-Null

Copy-Item "C:\path\to\private-backup\ledger.json" `
  .github\extensions\energy-invoice-dashboard\artifacts\ledger.json
Copy-Item "C:\path\to\private-backup\invoices\*.pdf" `
  .github\extensions\energy-invoice-dashboard\artifacts\invoices\
```

Restore the ledger and its PDFs together so the archive links remain intact.
Before continuing, confirm Git ignores both kinds of private data:

```powershell
git check-ignore -v -- `
  .github\extensions\energy-invoice-dashboard\artifacts\ledger.json `
  .github\extensions\energy-invoice-dashboard\artifacts\invoices\example.pdf
```

Reload Copilot extensions (or close and reopen this repository session), then
open the **Energy invoice dashboard** canvas. Without restored data, uploading
PDFs creates a new local ledger; it does not publish anything to GitHub.
