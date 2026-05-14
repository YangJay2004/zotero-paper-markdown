# Paper Markdown

Paper Markdown 是一个 Zotero 8/9 插件，用 MinerU Precision Extract API 将 Zotero 中的论文 PDF 转换成 Markdown，并把生成的 `.md` 文件作为同一条目的 Zotero 附件保存。

## 功能

- 右键 Zotero 条目或 PDF 附件，执行 `Convert to Markdown with MinerU`
- 使用 MinerU `/api/v4/file-urls/batch` 签名上传流程
- 默认 `model_version = vlm`
- 将 Markdown 附件保存到源 PDF 所属条目下
- 可按 Zotero 重命名模板或插件模板生成 Markdown 文件名
- 可选择保留 MinerU 原始 zip
- 支持新 PDF 自动转换
- 支持所有库、当前分类、当前选中条目的批量预览和队列转换
- 支持失败重试、当前批次后停止、运行日志和 Markdown 附件清理
- 支持不上传 PDF 的 MinerU API token 连通性测试

## 环境要求

- Zotero 8.999 或更新版本，最高兼容到 `9.*`
- 可用的 MinerU API token
- macOS/Linux shell 环境，或其他带 `bash`、`zip`、`node` 的环境

## 从源码打包 XPI

```bash
./scripts/build-xpi.sh
```

生成文件会出现在：

```text
dist/paper-markdown-0.5.7.xpi
```

发布构建时可以临时注入 GitHub 相关地址，而不用把本地测试值写死进源码：

```bash
ADDON_ID="paper-markdown@your-domain.example" \
HOMEPAGE_URL="https://github.com/<owner>/paper-markdown" \
UPDATE_URL="https://github.com/<owner>/paper-markdown/releases/latest/download/updates.json" \
./scripts/build-xpi.sh
```

`ADDON_ID` 一旦对外发布就应保持稳定，否则 Zotero 会把后续构建视为另一个插件。

## 安装

1. 运行 `./scripts/build-xpi.sh`。
2. 打开 Zotero。
3. 进入 `Tools -> Plugins`。
4. 选择 `Install Add-on From File...`。
5. 选择 `dist/paper-markdown-0.5.7.xpi`。
6. 如果 Zotero 要求重启，按提示重启。

## 配置

安装后进入 Zotero 设置页中的 `Paper Markdown` 面板。

### MinerU API

- `API Token`：填入 MinerU API token。token 只保存在本机 Zotero preferences 中，不会写入源码或 XPI。
- `Test MinerU API`：只测试 token 和 API 连通性，不上传 PDF。

### 解析设置

- `Model`：默认 `vlm`，也可改为 `pipeline`。
- `Language`：默认 `ch`。英文论文可改为 `en`。
- `Page ranges`：留空表示全篇；可填 `1-20,25` 这类页码范围。
- `MinerU batch size`：每个 MinerU 批次包含的 PDF 数量，默认 `10`。
- `Upload concurrency`：本地并行上传数，默认 `4`。网络不稳定或 API 限流时可以调低。
- `Enable OCR`：对扫描版或文本层质量差的 PDF 开启。
- `Enable formula`：开启公式识别，默认开启。
- `Enable table`：开启表格识别，默认开启。

### 输出设置

- `Existing Markdown`：
  - `Skip`：已有 Markdown 时跳过，默认值。
  - `Create new version`：保留旧附件，生成一个新 Markdown。
  - `Overwrite`：覆盖已有的 Paper Markdown 生成附件。
- `Use Zotero rename template`：优先使用 Zotero 自身文件重命名模板。
- `Markdown filename template`：未使用 Zotero 模板时使用插件模板。
- `Keep raw MinerU zip`：保存 MinerU 原始 zip，便于调试或保留中间产物。
- `Conservatively normalize Markdown heading levels`：保守修复 Markdown 标题层级。
- `Auto convert newly added PDFs`：新增 PDF 附件后自动排队转换。建议先确认 token、命名和已有 Markdown 策略后再开启。

## 使用

单篇转换：

1. 在 Zotero 中选择一篇带本地 PDF 附件的论文。
2. 右键选择 `Convert to Markdown with MinerU`。
3. 转换成功后，Markdown 会作为同一论文条目下的子附件出现。

批量转换：

1. 打开 `Tools -> Open Paper Markdown Panel`。
2. 在 `Batch Conversion` 中选择范围：所有库、当前分类或当前选中条目。
3. 先点 `Preview` 检查待转换、已转换和不可用 PDF。
4. 确认后点 `Start Queue`。
5. 失败项可用 `Retry Failed` 重试。

Markdown 清理：

1. 打开 `Tools -> Open Paper Markdown Panel`。
2. 在 `Markdown Management` 中选择清理范围和目标。
3. 先点 `Preview Cleanup`。
4. 只在确认预览列表无误后点 `Delete Previewed Attachments`。

## 发布到 GitHub

这个目录目前可以按普通源码仓库发布。建议不要把 `dist/`、`tmp/`、`__pycache__/` 提交到仓库；发布产物放到 GitHub Release。

```bash
git init
git add .
git commit -m "Initial Paper Markdown plugin"
git branch -M main
git remote add origin git@github.com:<owner>/paper-markdown.git
git push -u origin main
```

创建 release：

```bash
VERSION="$(node -e "process.stdout.write(require('./manifest.json').version)")"

ADDON_ID="paper-markdown@your-domain.example" \
HOMEPAGE_URL="https://github.com/<owner>/paper-markdown" \
UPDATE_URL="https://github.com/<owner>/paper-markdown/releases/latest/download/updates.json" \
./scripts/build-xpi.sh

UPDATE_LINK="https://github.com/<owner>/paper-markdown/releases/download/v$VERSION/paper-markdown-$VERSION.xpi" \
ADDON_ID="paper-markdown@your-domain.example" \
node scripts/create-update-manifest.js
```

然后在 GitHub 上创建 `v0.5.7` 这样的 release，并上传：

- `dist/paper-markdown-0.5.7.xpi`
- `dist/updates.json`

如果暂时不需要自动更新，可以只上传 `.xpi`，并且发布构建时不传 `UPDATE_URL`。

## 隐私说明

转换时插件会把本地 Zotero PDF 上传到 MinerU。请只转换你有权上传到该服务的文档。插件日志不会打印 API token，token 也不会被打进 XPI。

## 开发参考

- Zotero 插件需要 `manifest.json` 中的 `applications.zotero` 字段才能安装。
- Zotero 7 之后的更新清单使用 JSON 格式，`updates.json` 中包含 `update_link` 和 `sha256`。
- 官方迁移说明见 [Zotero 7 for Developers](https://www.zotero.org/support/dev/zotero_7_for_developers)。
