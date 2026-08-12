# 构建资产清单（0.13.14）

Git 只保存维护源码和小型运行资源。下列大体积二进制按仓库规则不进入 Git；正式打包前必须放到指定位置并校验哈希。

| 目标路径 | 字节数 | SHA-256 |
|---|---:|---|
| `media-tools/ffmpeg.exe` | 87,638,016 | `2CE797A0F88D7F067180338FB227F7B1928EA727BD9A4D7A1D022F7C52AF71A3` |

本机已安装版本可从以下位置复制：

```text
C:\Users\Administrator\AppData\Local\Programs\xiangsu-seedance-bridge\resources\media-tools\ffmpeg.exe
```

源码内两个原生助手已纳入 Git，构建时也应保持以下校验值：

| 路径 | 字节数 | SHA-256 |
|---|---:|---|
| `app/assets/face-grid-processor.exe` | 11,264 | `AC65468BE5376AEC7276B9D91022DD8EEDDDAAF6467DB5B852DEDBC99F78BBCA` |
| `app/assets/xiangsu-window-hider.exe` | 7,680 | `5522FEC2BD7F87D491E5A76B4372DF0655D24B8C0E8E0777C30462B8BAE0374E` |

PowerShell 校验：

```powershell
Get-FileHash -Algorithm SHA256 media-tools\ffmpeg.exe,app\assets\face-grid-processor.exe,app\assets\xiangsu-window-hider.exe
```
