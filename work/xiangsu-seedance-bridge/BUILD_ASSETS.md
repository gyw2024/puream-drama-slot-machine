# 构建资产清单（0.13.21）

Git 只保存维护源码和小型运行资源。正式打包前必须准备下列固定二进制并校验；任一大小、SHA-256 或 FFmpeg 版本不匹配都会阻止构建。

| 目标路径 | 字节数 | SHA-256 |
|---|---:|---|
| `media-tools/ffmpeg.exe` | 87,638,016 | `2CE797A0F88D7F067180338FB227F7B1928EA727BD9A4D7A1D022F7C52AF71A3` |
| `app/assets/face-grid-processor.exe` | 11,264 | `AC65468BE5376AEC7276B9D91022DD8EEDDDAAF6467DB5B852DEDBC99F78BBCA` |
| `app/assets/xiangsu-window-hider.exe` | 7,680 | `5522FEC2BD7F87D491E5A76B4372DF0655D24B8C0E8E0777C30462B8BAE0374E` |

自动准备并校验 FFmpeg：

```powershell
npm.cmd run prepare:build-assets
npm.cmd run verify:build-assets
```

下载脚本固定使用：

```text
https://github.com/GyanD/codexffmpeg/releases/download/7.1/ffmpeg-7.1-essentials_build.zip
```

脚本不会信任文件名或归档结构：解压后只选择 `bin\ffmpeg.exe`，校验目标文件精确大小和 SHA-256，再复制到 `media-tools`；`verify:build-assets` 还会执行文件并确认版本为 `FFmpeg 7.1 essentials_build-www.gyan.dev`。

手工校验：

```powershell
Get-FileHash -Algorithm SHA256 media-tools\ffmpeg.exe,app\assets\face-grid-processor.exe,app\assets\xiangsu-window-hider.exe
npm.cmd run verify:build-assets
```

FFmpeg 来源与许可证信息见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
