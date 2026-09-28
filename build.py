"""Build a standalone index.html (for GitHub Pages) from page.html (the artifact source, which has no document skeleton)."""
from pathlib import Path

root = Path(__file__).parent
page = (root / 'page.html').read_text(encoding='utf-8')
# <title>、<meta>、字型 <link> 放進 <head>，其餘放進 <body>
cut = page.index('<style>')
meta, body = page[:cut].strip(), page[cut:]
html = (
    '<!doctype html>\n<html lang="zh-Hant">\n<head>\n'
    '<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
    + meta + '\n'
    '<style>body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>\n'
    '</head>\n<body>\n'
    + body + '\n</body>\n</html>\n'
)
(root / 'index.html').write_text(html, encoding='utf-8')
print('index.html built')
