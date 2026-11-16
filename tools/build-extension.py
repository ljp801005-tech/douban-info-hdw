#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把油猴脚本编译成 Chrome 扩展（Manifest V3）。

单一源文件是仓库根目录的 douban-pt-uploader.user.js，这里只做机械转换：
  - 头部 @version / @match / @connect → manifest.json 的 version / matches / host_permissions
  - 脚本正文 → extension/content.js（外面套一层 __DBPT_EXT.ready，等配置读进内存再跑）
  - 把「安装更新」指向扩展目录，而不是 .user.js

用法：  python3 tools/build-extension.py            # 构建
        python3 tools/build-extension.py --check    # 只校验产物是否与源文件一致
"""

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'douban-pt-uploader.user.js')
EXT_DIR = os.path.join(ROOT, 'extension')
OUT_CONTENT = os.path.join(EXT_DIR, 'content.js')
OUT_MANIFEST = os.path.join(EXT_DIR, 'manifest.json')

INSTALL_URL = 'https://github.com/ljp801005-tech/douban-info-hdw/tree/main/extension'

SHORT_DESC = ('在 PT 站种子详情页左上角一键生成 ◎ 格式豆瓣简介：'
              '粘贴豆瓣或 IMDb 链接，自动抓取片名、演职员、剧情，复制即可发种。')


def fail(msg):
    sys.stderr.write('构建失败：' + msg + '\n')
    sys.exit(1)


def read_source():
    with open(SRC, encoding='utf-8') as f:
        return f.read()


def header_block(text):
    m = re.search(r'// ==UserScript==(.*?)// ==/UserScript==', text, re.S)
    if not m:
        fail('找不到 UserScript 头部')
    return m.group(0), m.group(1)


def meta(block, key):
    return re.findall(r'^// @%s\s+(\S+)\s*$' % key, block, re.M)


def build_content(text):
    marker = '// ==/UserScript=='
    idx = text.find(marker)
    if idx < 0:
        fail('找不到头部结束标记')
    body = text[idx + len(marker):].lstrip('\n')

    # 扩展里「有新版本」应该去下载新版扩展，而不是装 .user.js
    if 'var UPDATE_URL = ' not in body:
        fail('正文里找不到 UPDATE_URL 定义，构建规则需要更新')
    body, n1 = re.subn(
        r"(  var UPDATE_URL = '[^']*';\n)",
        r"\1  // 扩展版：检查更新仍比对 .user.js 的版本号，但安装入口指向扩展目录\n"
        "  var INSTALL_URL = '%s';\n" % INSTALL_URL,
        body, count=1)
    body, n2 = re.subn(r'gm\.open\(UPDATE_URL\)', 'gm.open(INSTALL_URL)', body)
    body, n3 = re.subn(r'→ 点击安装更新', '→ 点击获取新版扩展', body)
    for name, n in (('UPDATE_URL 定义', n1), ('更新链接', n2), ('更新文案', n3)):
        if n != 1:
            fail('%s 替换次数异常（%d 次），请检查源脚本是否改动' % (name, n))

    head = ('/* 由 tools/build-extension.py 从 douban-pt-uploader.user.js 自动生成，请勿直接修改。\n'
            ' * 改了油猴脚本后执行 python3 tools/build-extension.py 重新生成。 */\n'
            'window.__DBPT_EXT.ready(function () {\n')
    tail = '\n});\n'
    return head + body.rstrip('\n') + tail


def build_manifest(block):
    version = (meta(block, 'version') or [''])[0]
    matches = meta(block, 'match')
    connects = meta(block, 'connect')
    if not version:
        fail('头部没有 @version')
    if len(matches) < 1:
        fail('头部没有 @match')

    hosts = []
    for c in connects:
        if c.startswith('*.'):
            hosts.append('https://%s/*' % c)
        else:
            hosts.append('https://%s/*' % c)
    # 去重保序，并去掉被 *.domain 通配覆盖的条目
    seen, uniq = set(), []
    for h in hosts:
        if h not in seen:
            seen.add(h)
            uniq.append(h)
    wild = [h for h in uniq if h.startswith('https://*.')]
    host_list = [h for h in uniq
                 if not any(h != w and h.endswith('.' + w[len('https://*.'):]) for w in wild)]

    return {
        'manifest_version': 3,
        'name': 'PT 站详情页 · 豆瓣简介生成',
        'version': version,
        'description': SHORT_DESC,
        'minimum_chrome_version': '102',
        'icons': {
            '16': 'icons/icon16.png',
            '48': 'icons/icon48.png',
            '128': 'icons/icon128.png'
        },
        'permissions': ['storage', 'clipboardWrite', 'declarativeNetRequest'],
        'host_permissions': host_list,
        'background': {'service_worker': 'background.js'},
        'action': {
            'default_title': '豆瓣简介生成',
            'default_popup': 'popup.html',
            'default_icon': {
                '16': 'icons/icon16.png',
                '48': 'icons/icon48.png',
                '128': 'icons/icon128.png'
            }
        },
        'content_scripts': [{
            'matches': matches,
            'js': ['shim.js', 'content.js'],
            'run_at': 'document_idle',
            'all_frames': True
        }]
    }


def main():
    check_only = '--check' in sys.argv
    text = read_source()
    _, block = header_block(text)

    content = build_content(text)
    manifest = build_manifest(block)
    manifest_text = json.dumps(manifest, ensure_ascii=False, indent=2) + '\n'

    if check_only:
        ok = True
        for path, want in ((OUT_CONTENT, content), (OUT_MANIFEST, manifest_text)):
            got = ''
            if os.path.exists(path):
                with open(path, encoding='utf-8') as f:
                    got = f.read()
            if got != want:
                sys.stderr.write('产物与源文件不一致：%s\n' % os.path.relpath(path, ROOT))
                ok = False
        if ok:
            print('产物与源文件一致（version %s）' % manifest['version'])
        return 0 if ok else 1

    os.makedirs(EXT_DIR, exist_ok=True)
    with open(OUT_CONTENT, 'w', encoding='utf-8') as f:
        f.write(content)
    with open(OUT_MANIFEST, 'w', encoding='utf-8') as f:
        f.write(manifest_text)

    print('已生成：')
    print('  %s  (%d 行)' % (os.path.relpath(OUT_CONTENT, ROOT), content.count('\n')))
    print('  %s  (version %s, %d 条 match)' % (
        os.path.relpath(OUT_MANIFEST, ROOT), manifest['version'], len(manifest['content_scripts'][0]['matches'])))
    return 0


if __name__ == '__main__':
    sys.exit(main())
