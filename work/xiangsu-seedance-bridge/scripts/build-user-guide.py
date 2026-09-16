"""Build the self-contained offline manual from the maintained Markdown source."""
from pathlib import Path
import html
import re

root = Path(__file__).resolve().parents[1]
source = (root / 'docs/新版设置与使用教程.md').read_text(encoding='utf-8')

def inline(value):
    value = html.escape(value)
    value = re.sub(r'\[([^]]+)\]\((https://[^)]+)\)', r'<a href="\2" target="_blank" rel="noopener">\1</a>', value)
    return re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', value)

parts, toc = [], []
table_count = 0
lines = source.splitlines()
i = 0
while i < len(lines):
    line = lines[i]
    if not line.strip():
        i += 1
        continue
    heading = re.match(r'^(#{1,3}) (.+)', line)
    if heading:
        level, title = len(heading[1]), heading[2]
        anchor = 'section-' + str(i)
        parts.append(f'<h{level} id="{anchor}">{inline(title)}</h{level}>')
        if level == 2:
            toc.append(f'<li><a href="#{anchor}">{inline(title)}</a></li>')
        i += 1
    elif line.startswith('|'):
        table_count += 1
        rows = []
        while i < len(lines) and lines[i].startswith('|'):
            cells = [cell.strip() for cell in lines[i].strip('|').split('|')]
            if not all(re.fullmatch(r':?-+:?', cell) for cell in cells):
                tag = 'th' if not rows else 'td'
                rows.append('<tr>' + ''.join(f'<{tag}>{inline(cell)}</{tag}>' for cell in cells) + '</tr>')
            i += 1
        parts.append(f'<div class="table-scroll" tabindex="0" role="region" aria-label="对照表 {table_count}，可横向滚动"><table><thead>' + rows[0] + '</thead><tbody>' + ''.join(rows[1:]) + '</tbody></table></div>')
    elif re.match(r'^(\d+\. |\- )', line):
        ordered = bool(re.match(r'^\d+\.', line))
        tag = 'ol' if ordered else 'ul'
        items = []
        pattern = r'^\d+\. ' if ordered else r'^\- '
        while i < len(lines) and re.match(pattern, lines[i]):
            items.append('<li>' + inline(re.sub(pattern, '', lines[i])) + '</li>')
            i += 1
        parts.append(f'<{tag}>' + ''.join(items) + f'</{tag}>')
    elif line.startswith('> '):
        parts.append('<blockquote>' + inline(line[2:]) + '</blockquote>')
        i += 1
    else:
        parts.append('<p>' + inline(line) + '</p>')
        i += 1

page = '''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'"><title>纯梦短剧老虎机 · 设置与使用教程</title><style>
*{box-sizing:border-box}html{scroll-padding-top:24px}body{margin:0;background:#f4f1eb;color:#25241f;font:17px/1.85 system-ui,"Microsoft YaHei",sans-serif}a{color:#714700;text-underline-offset:4px}a:focus-visible,[tabindex]:focus-visible{outline:3px solid #075c9d;outline-offset:4px}.skip{display:block;padding:12px 24px;background:#fff}.layout{max-width:1320px;margin:auto;padding:32px;display:grid;grid-template-columns:270px minmax(0,1fr);gap:36px}nav{position:sticky;top:24px;align-self:start;padding:20px;background:#fff;border:1px solid #d5cabb;border-radius:12px}nav ol{padding-left:0;list-style:none}nav li{margin:9px 0;font-size:15px}main{min-width:0;background:#fff;padding:34px 42px;border-radius:12px;border:1px solid #d5cabb}h1{font-size:30px;line-height:1.4;margin:0 0 24px}h2{font-size:25px;line-height:1.5;margin:48px 0 18px;border-top:2px solid #b99046;padding-top:24px}h3{font-size:20px;margin:30px 0 14px}p{margin:16px 0}li{margin:10px 0}strong{font-weight:750}.table-scroll{max-width:100%;overflow:auto;margin:24px 0}table{border-collapse:collapse;width:100%;min-width:520px;font-size:15px}th,td{border:1px solid #cfc4b4;padding:12px;text-align:left;vertical-align:top}th{background:#eee6d6}blockquote{margin:24px 0;padding:20px;border-left:4px solid #947035;background:#f6f1e7}.tip{font-size:14px;color:#565149}.top{display:inline-block;margin-top:36px;padding:8px} @media(max-width:850px){.layout{display:block;padding:14px}nav{position:static;margin-bottom:18px}main{padding:24px 18px}h1{font-size:26px}h2{font-size:23px}}@media print{body{background:#fff;font-size:11pt}.layout{display:block;padding:0;max-width:none}nav,.skip,.top{display:none}main{border:0;padding:0}h2{break-after:avoid}tr{break-inside:avoid}.table-scroll{overflow:visible}table{min-width:0;font-size:9pt}a{color:inherit}}
</style></head><body id="top"><a class="skip" href="#content">跳到教程正文</a><div class="layout"><nav aria-label="教程目录"><strong>设置与使用教程</strong><p class="tip">离线可读 · 目录定位<br>外部浏览器可查找和打印</p><ol>''' + ''.join(toc) + '</ol></nav><main id="content">' + ''.join(parts) + '<a class="top" href="#top">返回顶部</a></main></div></body></html>'
(root / 'app/renderer/user-guide.html').write_text(page, encoding='utf-8')
print(f'Built offline guide: {len(source)} characters, {len(toc)} chapters')
