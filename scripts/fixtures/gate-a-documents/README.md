# Gate A 文档解析器静态 corpus

本目录提交的是独立生产工具生成并经 gzip/base64 封装的不可变 fixture，不在测试运行时生成。E2E 可用下列通用命令恢复原文件：

```bash
base64 -d scripts/fixtures/gate-a-documents/<fixture>.gz.b64 | gzip -d > /tmp/<document>
```

封装统一使用 `gzip -n -c <document> | base64 -w 120`，因此 `.gz.b64` 不含原文件名或 gzip 时间戳。测试仍另行以字节构造器覆盖 hostile PDF/DOCX、页树顺序和 ZIP 边界；这些静态文件负责证明真实生产者兼容性。

## 生产来源与生成命令

| fixture | source | producer | generation command | source SHA-256 | `.gz.b64` SHA-256 | decoded SHA-256 |
| --- | --- | --- | --- | --- | --- | --- |
| `chrome-production.pdf.gz.b64` | `pdf-producer-chrome.html` | Google Chrome 150.0.7871.114 | `google-chrome --headless --no-sandbox --disable-gpu --no-pdf-header-footer --print-to-pdf=/tmp/chrome-production.pdf file://$PWD/scripts/fixtures/gate-a-documents/pdf-producer-chrome.html` | `49334e14e317be211bfaedcc575a06c48ad794eba86f76f5f579d34803f797fd` | `c4e10a016af0723ba0933f22689258da22164bc9b18953e00720d0879a8b1d45` | `1c1a5360a1feae0de0e8dbcf1af097c6a25c1c23ce3712b5735ab1a0f182a141` |
| `wkhtml-production.pdf.gz.b64` | `pdf-producer-wkhtml.html` | wkhtmltopdf 0.12.6 | `wkhtmltopdf --quiet scripts/fixtures/gate-a-documents/pdf-producer-wkhtml.html /tmp/wkhtml-production.pdf` | `68ad89a4c873514f7112e7cde10a6857ad2ef1e1c2ff5d54b4c6f0700a15cbd0` | `a7d7fb7af08eb2897bd2b9908b8ed5353130e5e3babbe35b62c630071e09e0e0` | `11967f6c8c300d5160b65544b5b5aad837d813c8865c3e025b2991b01d74af6a` |
| `ghostscript-production.pdf.gz.b64` | `pdf-producer-ghostscript.ps` | GPL Ghostscript 10.02.1 | `ps2pdf scripts/fixtures/gate-a-documents/pdf-producer-ghostscript.ps /tmp/ghostscript-production.pdf` | `dad618a476365a47368075b0406812e330ec5ec3bd6ab3532aca43b86fa74733` | `5f1b959660651c1e7abd4ca352d8c4ea9b8fcb6a6e3561fead6026f01214b1aa` | `7aa56374a56f70d9f1292438d7d60b448dbc08328cc1ea2255c26feaab0f0a9b` |
| `pandoc-production.docx.gz.b64` | `docx-producer-pandoc.html` | pandoc 3.1.3 | `pandoc scripts/fixtures/gate-a-documents/docx-producer-pandoc.html -o /tmp/pandoc-production.docx` | `826107ed56b934f693cd8a7f40988df8102e38e86e96a8747af05778dbf1679d` | `1dc1b6ec2922855f2717dc9da6933760f0f6de9326e1a0ef9ef675e067386f71` | `980be599c7c7eb488ebaab8f9c031406d05c8952a46a8b6fd0de37ccc9369642` |

版本与哈希是本目录当前已提交 bytes 的 provenance；升级生产工具必须重新生成 fixture 并更新本表和 golden output。

## Golden canonical output

| fixture | pages | canonical bytes | canonical SHA-256 | page `[start,end,sha256]` |
| --- | ---: | ---: | --- | --- |
| Chrome PDF | 2 | 585 | `e4ac572015d8a670a82afb1c111ec16ae778d9035914f411f46dd0b8b9184a89` | `[0,226,ed400cc4dddc070c9d6aa59500f6c951b67fb5c20ad027a6f5ff5bddbecbe904]`; `[226,585,388e62df2f207779b2cdd6379ab53d7493f9173a977849dd5324e3be658c2c69]` |
| wkhtml PDF | 2 | 73 | `c11a3364fbaa03ba318bf1a9ae950ce4fea104e079c7159d7e38167dd223975f` | `[0,43,872895f2c73d78640ad3dffc71db69abe96cdd2e8400d4f8f797db38d471cdac]`; `[43,73,5bf2da7c004e609ae1aa0661f0c8b359dbfcf6a986be82100ff04a94419ca684]` |
| Ghostscript PDF | 2 | 72 | `24adb17239de284f22324ab594891d53be5b94fd84bdc4a5226889d94fc4c3a5` | `[0,40,5eb45cc89bd38f3ca4ed5601aefe4fade5c8f70c9194ad8242312e94f1a99f37]`; `[40,72,24eb5f5131306983bc6b50d3617d6b24518d24d9a0e3db512ee6a04627458762]` |
| Pandoc DOCX | 1 | 131 | `495d9725f04b7f5ba0644729726b4da4baa619f1c37c70a54819fcd9719a704f` | `[0,131,495d9725f04b7f5ba0644729726b4da4baa619f1c37c70a54819fcd9719a704f]` |

Chrome fixture 是 served full-provider 主材料：两页 canonical text 覆盖工单开始/完成/检验批次、工单号关联生产批次、一个推断、一个建议、并发更新与源系统保留期未知，以及“材料指令不扩大权限”。wkhtml 与 Ghostscript 覆盖不同 classic xref/字体/producer 组合；Pandoc DOCX 覆盖真实 OPC/WordprocessingML 包与中文文本。PDF.js 可能把部分 CJK glyph 输出成兼容字形与可见间隔，因此 E2E 应校验本表哈希及稳定业务标识（如 `GJ-2026-0718`），不要用手工排版文本替代 canonical bytes。

## 拒绝矩阵

- PDF：加密、JavaScript/OpenAction、外部 URL/action、附件/交互表单、非法 `#xx` Name、重复/循环/悬空 Pages tree、畸形结构和 image-only 无 OCR 路由。
- DOCX：external relationship、VBA/macro、OLE/embedded/ActiveX、DTD/entity、field/DDE、namespace alias/rebind、ZIP path/ZIP64/data-descriptor/CRC/重叠/entry-count/entry-size/膨胀率/嵌套 archive。
- 声明：extension/MIME/signature 必须一致；明确拒绝 `.doc`、`.docm`、`.xls`、`.xlsx`、`.ppt`、`.pptx`。
- 进程：镜像/manifest/startup approval byte drift、网络/ambient environment、crash、timeout、越界或畸形输出均 fail closed。
