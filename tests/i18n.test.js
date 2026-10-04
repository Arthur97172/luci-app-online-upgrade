#!/usr/bin/env node
// i18n 回归测试：直接对 online-upgrade.js 里的展示层翻译辅助函数做断言。
//
// 为什么需要它：shell 的输出行由 JS 逐行翻译，而 _() 的查表是「精确匹配 + trim」，
// 任何一处 msgid 对不上都会静默退回英文（不报错）。本文件把这条链路变成可执行的断言。
//
// 两个必须守住的前提（对应 I / J / L 三段守卫）：
//   1. po2lmo 的 extract_string 只反转义 \" 和 \\，不处理 \n —— 故 msgid 必须单行，
//      换行要用 _('a') + '\n' + _('b') 拼在 _() 外面。本文件的 po 解析严格照此实现，
//      不能用 JSON.parse（那会反转义 \n，恰好掩盖这类失效）。
//   2. msgid 不得有首尾空白 —— _() 查表前会 trim。
//
// 注意：I/L 段用正则扫 JS 源码，注释里出现的「下划线括号 + 字面量」示例也会被扫到，
// 所以不要在 view 的注释里写这种例子。
//
// 运行：node tests/i18n.test.js

'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var JS_PATH = path.join(ROOT, 'root/www/luci-static/resources/view/system/online-upgrade.js');
var PO_PATH = path.join(ROOT, 'po/zh_Hans/online-upgrade.po');
var SH_PATH = path.join(ROOT, 'root/usr/bin/online-upgrade.sh');

var fails = 0, checks = 0;
function ok(cond, label, extra) {
	checks++;
	if (!cond) { fails++; console.log('FAIL  ' + label + (extra ? '\n      ' + extra : '')); }
}
function eq(got, want, label) {
	ok(got === want, label, 'got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want));
}

// ---------- 载入 po，建立与 cbi.js 一致的 _() ----------

// 复刻 po2lmo 的 extract_string：**只**反转义 \" 和 \\，其余一律原样保留。
//
// 这一点是整条链路最隐蔽的坑：po2lmo 不处理 \n，于是 lmo 的键是「字面反斜杠+n」串的
// sfh 哈希；而 JS 源码里写 _('a\nb') 时，JS 解析器会把它变成**真实换行**，_() 算出的
// 哈希必然不同 —— 含 \n 的 msgid 在运行时永远查不到（静默退回英文），且 msgstr 里若带
// \n 也会以字面反斜杠形式显示出来。
//
// 因此 po 的解析必须与 po2lmo 一致，不能图省事用 JSON.parse（那会反转义 \n，从而
// 恰好掩盖上面这个 bug —— 本测试初版就是这么写的，漏掉了 6 处失效的确认对话框）。
function poUnescape(s) {
	var out = '', i = 0;
	while (i < s.length) {
		if (s[i] === '\\' && i + 1 < s.length && (s[i + 1] === '"' || s[i + 1] === '\\')) {
			out += s[i + 1];
			i += 2;
		} else {
			out += s[i];
			i++;
		}
	}
	return out;
}

var poText = fs.readFileSync(PO_PATH, 'utf8');
var TR = {};
var RAW_PO = {};   // 原始 po 行（未反转义），用于诊断
(function parsePo() {
	var lines = poText.split('\n');
	for (var i = 0; i < lines.length; i++) {
		var mid = lines[i].match(/^msgid "(.*)"$/);
		if (!mid) continue;
		var mstr = (lines[i + 1] || '').match(/^msgstr "(.*)"$/);
		if (!mstr) continue;
		var key = poUnescape(mid[1]);
		if (key) { TR[key] = poUnescape(mstr[1]); RAW_PO[key] = mid[1]; }
	}
})();

// 复刻 luci-base/htdocs/luci-static/resources/cbi.js 的 _()：查表键会 trim
function _(s) {
	var k = String(s).trim();
	return TR[k] || s;
}

// ---------- 从 view 里抽出翻译辅助块并求值 ----------

var jsSrc = fs.readFileSync(JS_PATH, 'utf8');

function extractHelpers(src) {
	var start = src.indexOf('// ===== 展示层翻译辅助 =====');
	if (start < 0) throw new Error('未找到翻译辅助块起始标记');
	var fn = src.indexOf('function trLine(', start);
	if (fn < 0) throw new Error('未找到 trLine');
	// 从 trLine 的左花括号开始配平，得到函数结束位置
	var open = src.indexOf('{', fn);
	var depth = 0, end = -1;
	for (var i = open; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
	}
	if (end < 0) throw new Error('trLine 花括号不配平');
	return src.slice(start, end);
}

var H = new Function(
	'_',
	extractHelpers(jsSrc) +
	'\nreturn { fmt: fmt, trReason: trReason, trFail: trFail, trLine: trLine,' +
	' REASON_TEMPLATES: REASON_TEMPLATES, FAIL_TEMPLATES: FAIL_TEMPLATES,' +
	' OUT_KEYS: OUT_KEYS, OUT_PATTERNS: OUT_PATTERNS };'
)(_);

// ---------- A. trLine 功能断言（用 shell 的真实输出行） ----------

console.log('--- A. trLine：整行精确命中 ---');
eq(H.trLine('  Firmware Online Upgrade'), '  固件在线升级', 'banner 标题');
eq(H.trLine('  Firmware Status'), '  固件状态', '状态块标题');
eq(H.trLine('  >>> New firmware available!'), '  >>> 发现新固件！', '有新固件提示');
eq(H.trLine('[1/2] Fetching release information...'), '[1/2] 正在获取 Release 信息...', 'GitHub 模式提示');
eq(H.trLine('[1/2] Firmware image URL mode, skipping release lookup'), '[1/2] 固件镜像下载地址模式，跳过 Release 获取', '直链模式提示');
eq(H.trLine('[2/2] Looking for the latest firmware...'), '[2/2] 正在查找最新固件...', '查找固件');
eq(H.trLine('Step 1: Downloading firmware...'), 'Step 1: 下载固件...', 'Step 1');
eq(H.trLine('  Saving the installed package list...'), '  正在保存已安装包列表...', '保存包列表');
eq(H.trLine('Update record has been reset.'), '更新记录已重置。', '重置记录');
eq(H.trLine('No default release source is used. Configure it first:'), '未使用默认固件源，请先完成配置：', '未配置仓库提示');

console.log('--- B. trLine：结构化键（值原样保留） ---');
eq(H.trLine('  System: ImmortalWrt'), '  系统: ImmortalWrt', 'System');
eq(H.trLine('  Architecture: x86_64'), '  架构: x86_64', 'Architecture');
eq(H.trLine('  Repository: owner/repo'), '  仓库: owner/repo', 'Repository');
eq(H.trLine('  Tag: v1.1.1'), '  标签: v1.1.1', 'Tag');
eq(H.trLine('  Firmware image URL: https://e.com/fw.img.gz'), '  固件镜像下载地址: https://e.com/fw.img.gz', '直链地址');
eq(H.trLine('  Current firmware: ImmortalWrt 24.10.8 (r36350)'), '  当前固件: ImmortalWrt 24.10.8 (r36350)', '当前固件');
eq(H.trLine('  New firmware version: v1.1.1'), '  新固件版本: v1.1.1', '新固件版本');
eq(H.trLine('  Latest firmware: fw.img.gz'), '  最新固件: fw.img.gz', '最新固件');
eq(H.trLine('  File size: 42 MB'), '  文件大小: 42 MB', '文件大小');
eq(H.trLine('  Build time: 2026-10-01 12:00:00'), '  编译时间: 2026-10-01 12:00:00', '编译时间');

console.log('--- C. trLine：Reason 稳定码渲染 ---');
eq(H.trLine('  Reason: first_check|'), '  检测依据: 首次检测', 'first_check');
eq(H.trLine('  Reason: new_snapshot|36350|36000'), '  检测依据: 新版 SNAPSHOT（r36350 > r36000）', 'new_snapshot');
eq(H.trLine('  Reason: snapshot_time|2026-10-01 12:00:00'), '  检测依据: 新版 SNAPSHOT（编译时间 2026-10-01 12:00:00）', 'snapshot_time');
eq(H.trLine('  Reason: latest_snapshot|'), '  检测依据: 已是最新 SNAPSHOT', 'latest_snapshot');
eq(H.trLine('  Reason: new_version|1.1.1|1.1.0'), '  检测依据: 新版固件 v1.1.1（当前 v1.1.0）', 'new_version');
eq(H.trLine('  Reason: recompiled|1.1.1'), '  检测依据: 固件重新编译（v1.1.1）', 'recompiled');
eq(H.trLine('  Reason: latest|1.1.1'), '  检测依据: 已是最新（v1.1.1）', 'latest');
eq(H.trLine('  Reason: recompiled_time|2026-10-01 12:00:00'), '  检测依据: 固件重新编译（2026-10-01 12:00:00）', 'recompiled_time');
eq(H.trLine('  Reason: up_to_date|'), '  检测依据: 已是最新', 'up_to_date');

console.log('--- D. trLine：动态行前缀（值原样保留） ---');
eq(H.trLine('  Backup created: /root/pre-upgrade-backup-x.tar.gz (12.0K)'), '  备份成功: /root/pre-upgrade-backup-x.tar.gz (12.0K)', '备份路径');
eq(H.trLine('  Backup created: 37 plugin files'), '  备份成功: 37 plugin files', '插件备份');
eq(H.trLine('  Firmware already downloaded, skipping (2026-10-01 12:00:00)'), '  固件已下载，跳过 (2026-10-01 12:00:00)', '跳过下载');
eq(H.trLine('  Recorded version: v1.1.1 (2026-10-01 12:00:00)'), '  已记录版本: v1.1.1 (2026-10-01 12:00:00)', '记录版本');
eq(H.trLine('  Download complete (42.0M)'), '  下载成功 (42.0M)', '下载完成');
eq(H.trLine('  Command: sysupgrade -f /tmp/b.tgz /tmp/fw.img'), '  命令: sysupgrade -f /tmp/b.tgz /tmp/fw.img', 'sysupgrade 命令');

console.log('--- E. trLine：锚定正则（中文语序可与英文不同） ---');
eq(H.trLine('  Archive contains 42 files'), '  包含 42 个文件', '归档文件数');
eq(H.trLine('  Archive contains  42  files'), '  包含 42 个文件', 'wc -l 前导空格容错');
eq(H.trLine('  Retry attempt 2...'), '  第 2 次重试...', '重试');
eq(H.trLine('  URL: https://e.com/fw.img.gz...'), '  地址: https://e.com/fw.img.gz...', '下载地址');
eq(H.trLine('  Current system: openwrt'), '  当前系统: openwrt', '当前系统');
eq(H.trLine('Error: GitHub API returned HTTP 500'), '错误：GitHub API 返回 HTTP 500', 'HTTP 错误');
eq(H.trLine('Error: download failed! (curl exit: 28)'), '错误：下载失败！（curl 退出码: 28）', '下载失败');
eq(H.trLine('Error: firmware size mismatch (expected 44040192 bytes, got 1234 bytes)'),
	'错误：固件大小不符（预期 44040192 字节，实际 1234 字节）', '大小不符');
eq(H.trLine('Hint: firmware file name is "fw.img.gz"; make sure the release really contains it'),
	'提示：固件文件名为 "fw.img.gz"，请确认 Release 中确实包含该文件', '固件名提示');
eq(H.trLine('  Error: GitHub repository / tag is not configured.'), '  错误：未配置 GitHub 仓库 / 标签。', '未配置仓库');

console.log('--- F. trLine：非文案行必须原样保留 ---');
eq(H.trLine('============================================'), '============================================', '分隔线');
eq(H.trLine("      uci set online-upgrade.settings.repo='owner/repo'"),
	"      uci set online-upgrade.settings.repo='owner/repo'", 'uci 命令');
eq(H.trLine(''), '', '空行');

console.log('--- G. trFail：failed: 稳定码 ---');
eq(H.trFail('failed:download:28'), '下载失败（curl exit: 28）', 'failed:download');
eq(H.trFail('failed:size:44040192:1234'), '固件大小不符（预期 44040192 字节，实际 1234 字节）', 'failed:size');
eq(H.trFail('failed:unknowncode:1'), 'unknowncode', '未知 failed 码回退为码本身');

console.log('--- H. trReason：未知码回退 ---');
eq(H.trReason('brand_new_code', []), 'brand_new_code', '未知 Reason 码');
eq(H.trReason(undefined, []), '', '空 Reason 码');

// ---------- I. 守卫：_() 字面量必须都能命中 po ----------

console.log('--- I. 守卫：_() 字面量 vs po ---');
var jsLits = {};
(function collectLits() {
	var re = /_\((['"])((?:[^\\]|\\.)*?)\1\)/g, m;
	while ((m = re.exec(jsSrc))) {
		try { jsLits[(0, eval)(m[1] + m[2] + m[1])] = 1; } catch (e) { /* 跨行拼接等，跳过 */ }
	}
})();
var orphans = Object.keys(jsLits).filter(function(k) { return !TR[k.trim()]; });
ok(orphans.length === 0, '存在查表必然落空的 _() 字面量',
	orphans.map(function(k) {
		var why = '';
		if (k !== k.trim()) why = '  ← 首尾有空白，_() 查表前会 trim';
		else if (/\n/.test(k)) why = '  ← 含真实换行：po2lmo 不反转义 \\n，键必然对不上（把 \\n 挪到 _() 外面拼接）';
		return JSON.stringify(k) + why;
	}).join('\n      '));
console.log('      (' + Object.keys(jsLits).length + ' 条字面量，全部命中)');

// ---------- L. 守卫：_() 字面量不得含 po2lmo 不处理的转义 ----------
//
// po2lmo 的 extract_string 只反转义 \" 和 \\。JS 源码里任何其他转义（\n \t \r \u \x…）
// 都会被 JS 解析器先变成真实字符，而 po 里存的是字面反斜杠序列 —— 两边哈希不同，译文
// 永远查不到；即便查到，msgstr 里的反斜杠序列也会原样显示给用户。
// 因此：_() 的 msgid 必须是单行纯文本，换行请用 _('a') + '\n' + _('b') 拼接。
var BAD_ESC = /\\(?![\\"])/;
var escLit = [];
Object.keys(jsLits).forEach(function(k) {
	if (BAD_ESC.test(k)) escLit.push(k);
});
// jsLits 的键已是 JS 运行时值（eval 过），反查源码里对应的转义写法仅用于提示
ok(escLit.length === 0, '_() 字面量含 po2lmo 不处理的转义（\\n 等），译文必然失效',
	escLit.map(function(k) { return JSON.stringify(k).slice(0, 80); }).join('\n      '));

// ---------- J. 守卫：msgid 不允许首尾带空格 ----------

console.log('--- J. 守卫：msgid 首尾空格 ---');
var padded = Object.keys(TR).filter(function(k) { return k !== k.trim(); });
ok(padded.length === 0, 'msgid 带首尾空格，_() 永远查不到',
	padded.map(function(k) { return JSON.stringify(k); }).join('\n      '));
console.log('      (' + Object.keys(TR).length + ' 条 msgid，无首尾空格)');

// ---------- K. 守卫：shell 的展示行必须能被翻译 ----------

console.log('--- K. 守卫：online-upgrade.sh 展示行覆盖 ---');
// 协议/命令/非展示行：不翻译是正确的，显式豁免
var SHELL_EXEMPT = [
	/^(immortalwrt|openwrt|unknown|x86-64)$/,
	/^[a-z0-9|_-]+$/,                       // 状态文件 token 与架构匹配模式
	/^\d+$/,
	/^\s*(uci|apk|sysupgrade)\b/,           // 给用户照抄的命令
	/^\s*$/,                                // 空行
	/^=+$/                                  // 分隔线
];
// shell 变量：${...}、$name、$1 等位置参数
var SH_VAR = /\$(?:\{[^}]*\}|[A-Za-z_0-9][A-Za-z0-9_]*)/g;
var shSrc = fs.readFileSync(SH_PATH, 'utf8');
var shLines = [];
(function collectEcho() {
	var re = /^\s*echo\s+"((?:[^"\\]|\\.)*)"/gm, m;
	while ((m = re.exec(shSrc))) {
		var lit = m[1].replace(/\\"/g, '"').replace(/\\\$/g, '$');
		// 跳过写状态文件的行（重定向到文件，不进输出框）
		var lineStart = shSrc.lastIndexOf('\n', m.index) + 1;
		var lineEnd = shSrc.indexOf('\n', m.index);
		var full = shSrc.slice(lineStart, lineEnd < 0 ? shSrc.length : lineEnd);
		if (/>>?\s*\/tmp\/online-upgrade[.-](status|log)/.test(full)) continue;
		// 跳过状态文件写入
		if (/^\s*(backing_up|downloading|downloaded|saving_ts|sysupgrade|failed:|RESULT=)/.test(lit)) continue;
		if (/\$\(/.test(lit)) continue;      // 命令替换，无法静态还原
		// 整行就是一个变量（辅助函数 echo 返回值，含 $1 这类位置参数），没有可翻译的文案
		if (lit.replace(SH_VAR, '').trim() === '') continue;
		shLines.push(lit);
	}
})();
var uncovered = [];
shLines.forEach(function(lit) {
	if (SHELL_EXEMPT.some(function(re) { return re.test(lit); })) return;
	// 把 shell 变量替换成占位符后再走一遍翻译，模拟 JS 收到的实际行
	var probe = lit.replace(SH_VAR, 'V');
	if (H.trLine(probe) === probe) uncovered.push(lit);
});
ok(uncovered.length === 0, 'shell 展示行无对应译文（会静默显示英文）',
	uncovered.map(function(s) { return JSON.stringify(s); }).join('\n      '));
console.log('      (' + shLines.length + ' 条 echo 字面量，除豁免外全部有译文)');

// ---------- 汇总 ----------

console.log('\n' + (fails === 0 ? '✅ 全部通过' : '❌ 有失败') + '：' + (checks - fails) + '/' + checks);
process.exit(fails ? 1 : 0);
