#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把油猴脚本编译成 Chrome 扩展（Manifest V3）。

单一源文件是仓库根目录的 douban-pt-uploader.user.js，这里只做机械转换：
  - 头部 @version / @match / @connect → manifest.json 的 version / matches / host_permissions
  - 脚本正文 → extension/content.js（外面套一层 __DBPT_EXT.ready，等配置读进内存再跑）
  - 把「安装更新」指向扩展目录，而不是 .user.js

用法：  python3 tools/build-extension.py            # 构建
        python3 tools/build-extension.py --check    # 只校验产物是否与源文件一致
        python3 tools/build-extension.py --zip      # 额外打包 dist/*.zip（发给别人用）

打包说明：zip 内根目录就是 manifest.json（没有外层 extension/ 文件夹），
解压出来那个目录可以直接在 chrome://extensions 里「加载已解压的扩展程序」。
Chrome 不支持直接安装 zip/crx，所以 zip 只是方便传输，不能拖进扩展页。
"""

import json
import os
import re
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'douban-pt-uploader.user.js')
EXT_DIR = os.path.join(ROOT, 'extension')
DIST_DIR = os.path.join(ROOT, 'dist')
OUT_CONTENT = os.path.join(EXT_DIR, 'content.js')
OUT_MANIFEST = os.path.join(EXT_DIR, 'manifest.json')

INSTALL_URL = 'https://github.com/ljp801005-tech/douban-info-hdw/releases/latest/download/douban-pt-extension.zip'

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


def skip_in_zip(name):
    """打包时跳过系统垃圾文件。"""
    base = os.path.basename(name)
    return base.startswith('.') or base in ('__MACOSX', 'Thumbs.db', 'desktop.ini')


def make_zip(version):
    """把 extension/ 打成 dist/<name>-v<version>.zip，zip 根目录即扩展根目录。"""
    if not os.path.isdir(EXT_DIR):
        fail('extension 目录不存在，先不带参数构建一次')
    manifest_path = os.path.join(EXT_DIR, 'manifest.json')
    if not os.path.exists(manifest_path):
        fail('extension/manifest.json 不存在')

    os.makedirs(DIST_DIR, exist_ok=True)
    # 文件名不写版本号：manifest 里已有版本，README 与 Release 可以用恒定链接
    out = os.path.join(DIST_DIR, 'douban-pt-extension.zip')
    if os.path.exists(out):
        os.remove(out)

    files = []
    for root, dirs, names in os.walk(EXT_DIR):
        dirs[:] = sorted(d for d in dirs if not skip_in_zip(d))
        for n in sorted(names):
            if skip_in_zip(n):
                continue
            full = os.path.join(root, n)
            files.append((full, os.path.relpath(full, EXT_DIR).replace(os.sep, '/')))

    arc_names = [a for _, a in files]
    if 'manifest.json' not in arc_names:
        fail('zip 根目录缺少 manifest.json')

    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for full, arc in files:
            info = zipfile.ZipInfo(arc, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with open(full, 'rb') as f:
                z.writestr(info, f.read())

    return out, len(files), os.path.getsize(out)


def main():
    check_only = '--check' in sys.argv
    want_zip = '--zip' in sys.argv
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

    if want_zip:
        out, count, size = make_zip(manifest['version'])
        print('  %s  (%d 个文件, %.1f KB)' % (
            os.path.relpath(out, ROOT), count, size / 1024.0))
        print('zip 根目录即扩展根目录，解压后直接「加载已解压的扩展程序」选它')
    return 0


if __name__ == '__main__':
    sys.exit(main())
