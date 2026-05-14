# Paper Markdown

Paper Markdown 是一个 Zotero 8/9 插件，用 MinerU Precision Extract API 将 Zotero 中的论文 PDF 转换成 Markdown，并把生成的 `.md` 文件作为同一条目的 Zotero 附件保存。

![Paper Markdown generated attachment in Zotero](docs/images/zotero-markdown-attachment.png)

转换完成后，插件会在原论文条目下新增一个 Markdown 子附件。上图中 `markdown-paper` 就是由 PDF 附件转换得到的 Markdown 文件，和原始 `Full Text PDF` 保持在同一个 Zotero 条目层级中，便于后续搜索、阅读、导出或由外部工具读取。

## 功能详解

### 单篇 PDF 转 Markdown

Paper Markdown 会在 Zotero 条目或 PDF 附件的右键菜单中加入 `Convert to Markdown with MinerU` 命令。触发后，插件会读取本地 PDF 附件，将 PDF 上传到 MinerU，并在 MinerU 返回结果后把 Markdown 文件保存回 Zotero。

完整流程：

```text
Zotero PDF attachment
  -> request MinerU signed upload URLs
  -> upload PDF to MinerU
  -> poll MinerU extraction result
  -> download result zip
  -> pick and rename Markdown output
  -> create Zotero stored Markdown attachment
```

### Markdown 附件保存

转换结果不是简单下载到外部目录，而是写回 Zotero 的附件系统：

- Markdown 会作为源论文条目的子附件保存。
- 默认文件名会跟随 Zotero 文件重命名模板。
- 也可以使用插件自己的 `Markdown filename template`。
- 插件会保留 Markdown 文件和必要的 MinerU 输出文件。
- 可选保留 MinerU 原始 zip，便于调试或归档。

### MinerU 解析参数

插件当前使用 MinerU `/api/v4/file-urls/batch` 签名上传接口，默认 `model_version = vlm`。用户可以在 Zotero 设置页中调整：

- 解析模型：`vlm` 或 `pipeline`
- 语言：默认 `ch`，英文论文可设为 `en`
- 页码范围：例如 `1-20,25`
- OCR：用于扫描版或文本层质量差的 PDF
- 公式识别：默认开启
- 表格识别：默认开启
- MinerU batch size：控制每个 MinerU 批次的 PDF 数量
- Upload concurrency：控制本地并行上传数

### 已有 Markdown 处理策略

当同一论文条目下已经存在 Markdown 附件时，可以选择：

- `Skip`：跳过已有 Markdown 的 PDF，适合日常批量补全。
- `Create new version`：保留旧 Markdown，再生成一个新版本。
- `Overwrite`：覆盖已有的 Paper Markdown 生成附件。

这个策略会同时影响单篇转换和批量转换。

### 批量转换和队列管理

插件提供 Paper Markdown Panel，用于批量处理 Zotero 库中的 PDF。批量任务支持三种范围：

- 所有库
- 当前分类
- 当前选中条目

批量转换前需要先 `Preview`。预览会统计：

- 当前范围内共有多少 PDF
- 多少 PDF 可以转换
- 多少 PDF 已经有 Markdown
- 多少 PDF 因缺少本地文件、不可编辑或其他原因不可转换
- 按当前已有 Markdown 策略实际会进入队列的任务数量

开始队列后，面板会显示：

- 总体队列进度
- 当前 MinerU 批次进度
- 成功、失败、跳过数量
- 失败项错误信息
- 失败任务重试入口
- 当前批次结束后停止的控制按钮

### 自动转换新 PDF

开启 `Auto convert newly added PDFs` 后，新加入 Zotero 的 PDF 附件会自动进入转换队列。建议先完成 API token 测试，并确认命名模板、OCR、已有 Markdown 策略后再开启。

### Markdown 附件清理

插件也提供 Markdown 管理功能，用于删除旧版或不符合当前规则的 Markdown 附件。清理操作会先预览，再执行删除。支持的清理目标包括：

- 旧版 MinerU `full.md` 附件
- 旧版或命名不符合当前规则的 Paper Markdown 附件
- 所有 Paper Markdown 生成附件
- 所有 Markdown-like 附件

清理只删除 Zotero 中的 Markdown 附件条目及其存储文件，不会删除原始 PDF。

### API 测试和隐私保护

设置页中的 `Test MinerU API` 只测试 API token 和 MinerU 服务连通性，不上传 PDF。转换任务真正开始时才会上传 PDF。插件不会把 API token 写入源码或 XPI，也不会在日志中打印 token。

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

源码中的插件 ID 和 GitHub 更新地址已经配置为：

```text
zotero-paper-markdown@yangjay2004.github.io
https://github.com/YangJay2004/zotero-paper-markdown/releases/latest/download/updates.json
```

插件 ID 一旦对外发布就应保持稳定，否则 Zotero 会把后续构建视为另一个插件。

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
git remote add origin https://github.com/YangJay2004/zotero-paper-markdown.git
git push -u origin main
```

创建 release：

```bash
VERSION="$(node -e "process.stdout.write(require('./manifest.json').version)")"

./scripts/build-xpi.sh

UPDATE_LINK="https://github.com/YangJay2004/zotero-paper-markdown/releases/download/v$VERSION/paper-markdown-$VERSION.xpi" \
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
