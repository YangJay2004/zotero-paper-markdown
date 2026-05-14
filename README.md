# Paper Markdown

Paper Markdown is a Zotero plugin that converts paper PDF attachments into Markdown files with the MinerU Precision Extract API. The generated Markdown is saved back into Zotero as a stored child attachment under the same paper item.

![Paper Markdown generated attachment in Zotero](docs/images/zotero-markdown-attachment.png)

In the example above, `markdown-paper` is a Markdown attachment generated from the paper's full-text PDF. It remains attached to the original Zotero item, so it can be searched, opened, exported, or consumed by external reading and note-taking tools alongside the source PDF.

## Features

- Convert a single Zotero PDF attachment to Markdown from the item context menu.
- Save generated Markdown files as Zotero stored child attachments.
- Use MinerU's signed batch upload flow for PDF extraction.
- Configure extraction model, language, page ranges, OCR, formula recognition, and table recognition.
- Use Zotero's rename template or a plugin-level filename template for Markdown output.
- Choose how existing Markdown attachments are handled: skip, version, or overwrite.
- Preview and run batch conversion across all libraries, the current collection, or selected items.
- Track queue progress, failed tasks, retries, and runtime logs in the Paper Markdown panel.
- Automatically convert newly added PDF attachments when enabled.
- Preview and clean up generated or legacy Markdown attachments without touching source PDFs.
- Test MinerU API connectivity without uploading a PDF.

## How It Works

Paper Markdown reads local Zotero PDF attachments, sends them to MinerU for extraction, downloads the result archive, selects the Markdown output, and stores that Markdown file back in Zotero.

```text
Zotero PDF attachment
  -> request MinerU signed upload URLs
  -> upload PDF to MinerU
  -> poll MinerU extraction result
  -> download result archive
  -> select and rename Markdown output
  -> create Zotero stored Markdown attachment
```

The plugin does not store converted files in an external library directory by default. Zotero remains the source of truth for the generated Markdown attachment.

## Requirements

- Zotero `8.999` or later, compatible with Zotero `9.*`
- A valid MinerU API token
- Local Zotero PDF attachments available on disk

## Installation

1. Download the latest `.xpi` file from [Releases](https://github.com/YangJay2004/zotero-paper-markdown/releases).
2. Open Zotero.
3. Go to `Tools -> Plugins`.
4. Choose `Install Add-on From File...`.
5. Select the downloaded `paper-markdown-*.xpi`.
6. Restart Zotero if prompted.

## Configuration

Open Zotero settings and select the `Paper Markdown` pane.

### MinerU API

| Setting | Description |
| --- | --- |
| `API Token` | MinerU API token used for extraction requests. |
| `Test MinerU API` | Checks token validity and API reachability without uploading a PDF. |

The token is stored only in local Zotero preferences. It is not bundled into the plugin package.

### Extraction

| Setting | Default | Description |
| --- | --- | --- |
| `Model` | `vlm` | MinerU extraction model. `pipeline` is also available. |
| `Language` | `ch` | Document language. Use `en` for English papers. |
| `Page ranges` | empty | Optional page selection, such as `1-20,25`. Empty means all pages. |
| `MinerU batch size` | `10` | Number of PDFs submitted in one MinerU batch. |
| `Upload concurrency` | `4` | Number of prepared PDF files uploaded in parallel. |
| `Enable OCR` | off | Use for scanned PDFs or low-quality text layers. |
| `Enable formula` | on | Enables formula recognition. |
| `Enable table` | on | Enables table recognition. |

### Output

| Setting | Default | Description |
| --- | --- | --- |
| `Existing Markdown` | `Skip` | Controls what happens when Markdown already exists for the same paper. |
| `Use Zotero rename template` | on | Uses Zotero's file-renaming rules for generated Markdown names. |
| `Markdown filename template` | title/creator/year template | Plugin-level fallback naming template. |
| `Keep raw MinerU zip` | off | Keeps MinerU's raw result archive for inspection. |
| `Conservatively normalize Markdown heading levels` | off | Adjusts heading levels when extraction output is structurally inconsistent. |
| `Auto convert newly added PDFs` | off | Queues new PDF attachments for conversion automatically. |

For `Existing Markdown`, the available policies are:

- `Skip`: leave the existing Markdown in place and skip conversion.
- `Create new version`: keep the existing Markdown and create a new attachment.
- `Overwrite`: replace an existing Paper Markdown generated attachment.

## Usage

### Convert One Paper

1. Select a Zotero item with a local PDF attachment, or select the PDF attachment directly.
2. Right-click and choose `Convert to Markdown with MinerU`.
3. Wait for the task to finish.
4. Open the generated Markdown child attachment under the same Zotero item.

### Batch Convert PDFs

1. Open `Tools -> Open Paper Markdown Panel`.
2. Choose a scope: all libraries, current collection, or selected items.
3. Click `Preview` to inspect what will be converted.
4. Click `Start Queue` to begin conversion.
5. Use `Retry Failed` for failed tasks if needed.
6. Use `Stop After Current` to stop after the active MinerU batch finishes.

The preview step reports how many PDFs are available, already converted, unavailable, and queued under the current settings.

### Clean Up Markdown Attachments

The Paper Markdown panel also includes Markdown management tools. Cleanup always starts with a preview and does not remove source PDF attachments.

Supported cleanup targets include:

- Legacy MinerU `full.md` attachments
- Old or nonconforming Paper Markdown attachments
- Paper Markdown generated attachments
- All Markdown-like attachments

## Privacy

PDF files are uploaded to MinerU only when a conversion task starts. The API connectivity test does not upload PDFs.

Use this plugin only for documents you are allowed to upload to MinerU. The plugin does not print the API token in logs and does not include the token in the XPI package.

## Build From Source

The release package is a Zotero `.xpi` archive. To build it locally:

```bash
./scripts/build-xpi.sh
```

The generated package is written to `dist/`.

## Compatibility

The plugin manifest currently declares:

```json
{
  "strict_min_version": "8.999",
  "strict_max_version": "9.*"
}
```

The published add-on ID is:

```text
zotero-paper-markdown@yangjay2004.github.io
```
