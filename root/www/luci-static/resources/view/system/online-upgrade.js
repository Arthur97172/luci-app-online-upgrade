"use strict";
"require view";
"require fs";
"require ui";

return view.extend({
	handleSave: null,
	handleSaveApply: null,
	handleReset: null,

	render: function() {
		var _this = this;
		var pollTimer = null;
		// 重启/IP 变更后用于探测重连的候选地址。必须在页面加载时从 UCI 取好快照——
		// 探测发生在路由器已下线之后，那时无法再执行 uci。
		var reconnectHosts = '';
		// UCI 未配置时的兜底列表（与 root/etc/config/online-upgrade 的默认值保持一致）
		var DEFAULT_RECONNECT_HOSTS = '192.168.1.1 10.0.0.1 immortalwrt.lan openwrt.lan';

		// 构造候选 URL：当前地址始终最优先，其后是配置的候选（去重）。
		// 协议沿用当前页面，避免 https 页面探测 http 被浏览器按混合内容拦截。
		function buildCandidates() {
			var proto = window.location.protocol;
			var hosts = [window.location.host];
			var list = (reconnectHosts || DEFAULT_RECONNECT_HOSTS).split(/[\s,]+/);
			for (var i = 0; i < list.length; i++) {
				var h = list[i].replace(/^https?:\/\//, '').replace(/\/+$/, '');
				if (h && hosts.indexOf(h) < 0) hosts.push(h);
			}
			return hosts.map(function(h) { return proto + '//' + h + '/'; });
		}

		// ===== 展示层翻译辅助 =====
		// 简单 %s 替换（不依赖 luci 的 sprintf；译文里 %s 的顺序需与源串一致）
		function fmt(tpl, args) {
			var i = 0;
			return String(tpl).replace(/%s/g, function() {
				return (i < args.length) ? String(args[i++]) : '';
			});
		}

		// 判定依据：shell 只输出稳定码（Reason: <code>|<arg>|...），文案在此渲染。
		// 字面量必须写在 _() 内，否则 i18n 扫描器提取不到。
		var REASON_TEMPLATES = {
			first_check:     _('First check'),
			new_snapshot:    _('New SNAPSHOT (r%s > r%s)'),
			snapshot_time:   _('New SNAPSHOT (build time %s)'),
			latest_snapshot: _('Already the latest SNAPSHOT'),
			new_version:     _('New firmware v%s (current v%s)'),
			recompiled:      _('Firmware recompiled (v%s)'),
			latest:          _('Already the latest (v%s)'),
			recompiled_time: _('Firmware recompiled (%s)'),
			up_to_date:      _('Already the latest')
		};

		function trReason(code, args) {
			var tpl = REASON_TEMPLATES[code];
			return tpl ? fmt(tpl, args || []) : (code || '');
		}

		// 升级失败：状态文件里的 failed:<code>:<args> 同样是稳定码，由 shell 写入
		var FAIL_TEMPLATES = {
			download: _('Download failed (curl exit: %s)'),
			size:     _('Firmware size mismatch (expected %s bytes, got %s bytes)')
		};

		function trFail(status) {
			var m = String(status).match(/^failed:([A-Za-z_]+)(?::([\s\S]*))?$/);
			if (!m) return status;
			var tpl = FAIL_TEMPLATES[m[1]];
			if (!tpl) return m[1];
			return fmt(tpl, m[2] ? m[2].split(':') : []);
		}

		// shell 输出里的结构化键（英文协议键），值保持原文。写成 [英文键, 译文] 便于扫描。
		var OUT_KEYS = [
			['Firmware Status',       _('Firmware Status')],
			['Current firmware:',     _('Current firmware:')],
			['New firmware version:', _('New firmware version:')],
			['Latest firmware:',      _('Latest firmware:')],
			['File size:',            _('File size:')],
			['Build time:',           _('Build time:')],
			['Reason:',               _('Reason:')],
			['System:',               _('System:')],
			['Architecture:',         _('Architecture:')],
			['Repository:',           _('Repository:')],
			['Tag:',                  _('Tag:')],
			['Firmware image URL:',   _('Firmware image URL:')],
			// 动态行：前缀翻译后，其后的值原样保留。
			// 注意 _() 查表前会 trim，msgid 带尾随空格将永远查不到 —— 空格必须在 _() 之外拼接。
			['Backup created: ',                 _('Backup created:') + ' '],
			['Firmware already downloaded, skipping ', _('Firmware already downloaded, skipping') + ' '],
			['Recorded version: ',               _('Recorded version:') + ' '],
			['Download complete ',               _('Download complete') + ' '],
			['Command: ',                        _('Command:') + ' ']
		];

		// 行内嵌动态值的输出：整行无法精确命中（含变量），用锚定正则捕获参数后套 _() 模板。
		// 译文里 %s 的顺序可自由调整（中文语序与英文不同），这正是不能只做前缀替换的原因。
		var OUT_PATTERNS = [
			// wc -l 在不同实现下可能带前导空格，故用 \s+ 容错
			[/^Archive contains\s+(\d+)\s+files$/,      _('Archive contains %s files')],
			[/^Retry attempt (\S+)\.\.\.$/,             _('Retry attempt %s...')],
			[/^URL: (.+)$/,                             _('URL: %s')],
			[/^Current system: (.+)$/,                  _('Current system: %s')],
			[/^Error: GitHub API returned HTTP (.+)$/,  _('Error: GitHub API returned HTTP %s')],
			[/^Error: download failed! \(curl exit: (.+)\)$/,
			                                            _('Error: download failed! (curl exit: %s)')],
			[/^Error: firmware size mismatch \(expected (.+) bytes, got (.+) bytes\)$/,
			                                            _('Error: firmware size mismatch (expected %s bytes, got %s bytes)')],
			[/^Hint: firmware file name is "(.+)"; make sure the release really contains it$/,
			                                            _('Hint: firmware file name is "%s"; make sure the release really contains it')]
		];

		// 输出框逐行翻译：整行精确命中优先；否则翻译行内已知键，键后的动态值原样保留。
		// 注意 _() 查表时会 trim，故缩进需自行剥离后再拼接。
		function trLine(line) {
			if (!line) return line;
			var m = line.match(/^(\s*)([\s\S]*)$/);
			var indent = m[1], body = m[2];
			if (!body) return line;
			var t = _(body);
			if (t !== body) return indent + t;
			for (var p = 0; p < OUT_PATTERNS.length; p++) {
				var pm = body.match(OUT_PATTERNS[p][0]);
				if (pm) return indent + fmt(OUT_PATTERNS[p][1], pm.slice(1));
			}
			for (var i = 0; i < OUT_KEYS.length; i++) {
				var key = OUT_KEYS[i][0];
				var idx = body.indexOf(key);
				if (idx < 0) continue;
				var val = body.substring(idx + key.length);
				if (key === 'Reason:') {
					var a = val.trim().split('|');
					val = ' ' + trReason(a[0], a.slice(1));
				}
				return indent + body.substring(0, idx) + OUT_KEYS[i][1] + val;
			}
			return line;
		}

		function runCheck() {
			var btn = document.getElementById('btn-check');
			if (!btn) return;
			btn.disabled = true;
			btn.textContent = _('Checking...');
			updateOutput(_('Checking for firmware updates, please wait...') + '\n');

			fs.exec('/usr/bin/online-upgrade.sh', ['check']).then(function(r) {
				var text = r.stdout + (r.stderr ? '\n' + r.stderr : '');
				updateOutput(text);
				btn.disabled = false;
				btn.textContent = _('Check Update');

				var resultEl = document.getElementById('check-result');
				if (!resultEl) return;

				if (/^RESULT=new$/m.test(text)) {
					resultEl.textContent = _('✅ New firmware available!');
					resultEl.style.color = '';
					var upgBtn = document.getElementById('btn-upgrade');
					var upgBtnClean = document.getElementById('btn-upgrade-clean');
					var forceBtn = document.getElementById('btn-force');
					var forceBtnClean = document.getElementById('btn-force-clean');
					if (upgBtn) upgBtn.style.display = 'inline-block';
					if (upgBtnClean) upgBtnClean.style.display = 'inline-block';
					if (forceBtn) forceBtn.style.display = 'none';
					if (forceBtnClean) forceBtnClean.style.display = 'none';
				} else if (/^RESULT=ratelimited$/m.test(text)) {
					resultEl.textContent = _('❌ Check failed - GitHub API rate limit exceeded');
					resultEl.style.color = '';
					var forceBtn = document.getElementById('btn-force');
					var forceBtnClean = document.getElementById('btn-force-clean');
					if (forceBtn) forceBtn.style.display = 'inline-block';
					if (forceBtnClean) forceBtnClean.style.display = 'inline-block';
				} else if (/^RESULT=error$/m.test(text)) {
					resultEl.textContent = _('❌ Check failed');
					resultEl.style.color = '';
					var forceBtn = document.getElementById('btn-force');
					var forceBtnClean = document.getElementById('btn-force-clean');
					if (forceBtn) forceBtn.style.display = 'inline-block';
					if (forceBtnClean) forceBtnClean.style.display = 'inline-block';
				} else {
					resultEl.textContent = _('✓ Already up to date');
					resultEl.style.color = '#4CAF50';
					var forceBtn = document.getElementById('btn-force');
					var forceBtnClean = document.getElementById('btn-force-clean');
					if (forceBtn) forceBtn.style.display = 'inline-block';
					if (forceBtnClean) forceBtnClean.style.display = 'inline-block';
					var upgBtn = document.getElementById('btn-upgrade');
					var upgBtnClean = document.getElementById('btn-upgrade-clean');
					if (upgBtn) upgBtn.style.display = 'none';
					if (upgBtnClean) upgBtnClean.style.display = 'none';
				}

				// 解析并显示版本信息（键为 shell 输出的英文协议键）
				var lines = text.split('\n');
				for (var i = 0; i < lines.length; i++) {
					var m = lines[i].match(/^\s*Latest firmware:\s*(\S+)/);
					if (m) {
						var el = document.getElementById('latest-ver');
						if (el) el.textContent = m[1];
					}
					// 大小不可知时 shell 直接省略该行，此处自然保持为空
					m = lines[i].match(/^\s*File size:\s*(.+)/);
					if (m) {
						var el = document.getElementById('latest-size');
						if (el) el.textContent = m[1].trim();
					}
					// 新版本号
					m = lines[i].match(/^\s*New firmware version:\s*(.+)/);
					if (m) {
						var el = document.getElementById('new-ver');
						if (el) el.textContent = m[1].trim();
					}
					// 检测依据：shell 给的是稳定码，此处渲染为当前语言的文案
					m = lines[i].match(/^\s*Reason:\s*(\S+)/);
					if (m) {
						var el = document.getElementById('check-reason');
						var ra = m[1].split('|');
						if (el) el.textContent = trReason(ra[0], ra.slice(1));
					}
				}
			}).catch(function(e) {
				updateOutput(_('Check failed:') + ' ' + e.message);
				btn.disabled = false;
				btn.textContent = _('Check Update');
			});
		}

		function showRebootOverlay() {
			if (document.getElementById('reboot-overlay')) return;
			// 刷写完成：先把进度条推到 100%，再弹重启提示，保证逻辑连贯
			var bar = document.getElementById('progress-bar');
			var label = document.getElementById('progress-label');
			var text = document.getElementById('progress-text');
			if (bar) bar.style.width = '100%';
			if (label) label.textContent = '100%';
			if (text) text.textContent = _('Flashing complete, the router is about to reboot...');
			var seconds = 120;
			var settled = false;
			var probeTimer = null;
			var probing = false;

			// 收到任何 HTTP 响应（含跨源 opaque 响应）即说明该地址已可达；只有网络层
			// 失败（reject）才算未上线。不能用 resp.ok：它要求 2xx，而重启后浏览器带着
			// 失效 cookie 访问 LuCI 会返回非 2xx，会被误判成"没上线"而永远等不到。
			function goTo(url) {
				if (settled) return;
				settled = true;
				if (probeTimer) clearInterval(probeTimer);
				window.location.href = url;
			}

			// 按优先级顺序探测（当前地址最优先）。不用并行：并行时"最先响应的地址"
			// 胜出，若候选里含其他设备（如光猫）可能误跳；顺序探测保证优先命中当前地址。
			function probeCandidates() {
				if (settled || probing) return;
				probing = true;
				var urls = buildCandidates();
				var i = 0;
				function next() {
					if (settled || i >= urls.length) { probing = false; return; }
					var u = urls[i++];
					var ctl = window.AbortController ? new AbortController() : null;
					var to = ctl ? setTimeout(function() { ctl.abort(); }, 3000) : null;
					// no-cors：跨源读不到响应内容，但能 resolve 就证明该地址可达
					fetch(u, {mode: 'no-cors', cache: 'no-store', method: 'GET', signal: ctl ? ctl.signal : undefined})
						.then(function() { if (to) clearTimeout(to); probing = false; goTo(u); })
						.catch(function() { if (to) clearTimeout(to); next(); });
				}
				next();
			}

			var candLinks = buildCandidates().map(function(u) {
				return E('a', {href: u, style: 'color:#4CAF50;margin:0 6px;'}, u.replace(/^https?:\/\//, '').replace(/\/$/, ''));
			});
			var overlay = E('div', {id: 'reboot-overlay', style: 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;font-family:sans-serif;'}, [
				E('div', {style: 'font-size:28px;font-weight:600;margin-bottom:10px;'}, _('🔄 The router is rebooting')),
				E('div', {id: 'reboot-tip', style: 'font-size:14px;color:#aaa;margin-bottom:20px;'}, _('Firmware flashed. Do NOT power off! Waiting for the router to come online...')),
				E('div', {id: 'countdown', style: 'font-size:48px;font-weight:700;'}, String(seconds)),
				E('div', {style: 'font-size:13px;color:#888;margin-top:8px;margin-bottom:24px;'}, _('seconds until auto-reconnect probe')),
				E('button', {style: 'padding:10px 30px;font-size:16px;border:2px solid #4CAF50;background:transparent;color:#4CAF50;border-radius:8px;cursor:pointer;', click: function() { probeCandidates(); }}, _('Reconnect Now')),
				E('div', {style: 'font-size:12px;color:#888;margin-top:22px;max-width:560px;text-align:center;line-height:1.9;'}, [
					_('If auto-reconnect fails, try one of these manually:'),
					E('div', {}, candLinks)
				])
			]);
			document.body.appendChild(overlay);

			var countdownEl = document.getElementById('countdown');
			var tipEl = document.getElementById('reboot-tip');
			var timer = setInterval(function() {
				seconds--;
				if (countdownEl) countdownEl.textContent = String(seconds);
				if (seconds <= 0) {
					clearInterval(timer);
					if (countdownEl) countdownEl.textContent = '...';
					if (tipEl) tipEl.textContent = _('Probing whether the router is online (candidate addresses are tried in order when the IP changed)...');
					probeCandidates();
					probeTimer = setInterval(probeCandidates, 5000);
				}
			}, 1000);
		}

		// 更新进度条（假进度条与真实状态驱动共用）
		function updateProgress(p, t) {
			var bar = document.getElementById('progress-bar');
			var label = document.getElementById('progress-label');
			var text = document.getElementById('progress-text');
			if (bar) bar.style.width = p + '%';
			if (label) label.textContent = p + '%';
			if (text && t) text.textContent = t;
		}

		function startUpgrade(isForce, keepConfig) {
			if (isForce) {
				var repo = (document.getElementById('cfg-repo')||{}).value.trim();
				var tag = (document.getElementById('cfg-tag')||{}).value.trim();
				var direct = (document.getElementById('cfg-direct-url')||{}).value.trim();
				if (!direct && (!repo || !tag)) {
					alert(_('Please fill in the firmware image URL, or parse a GitHub Release Tag URL, before forcing an update.'));
					return;
				}
			}
			var keepText = keepConfig
				? _('keep system configuration')
				: _('do NOT keep system configuration (this plugin only)');
			// 换行必须拼在 _() 外面：po2lmo 的 extract_string 只反转义 \" 和 \\，不处理 \n。
			// 若把换行写进 msgid，JS 侧算的是「真实换行」的哈希、lmo 里存的是「字面反斜杠+n」
			// 的哈希，两边必然不等 —— 译文永远查不到，且 msgstr 会把反斜杠原样显示出来。
			// 注：注释里不要写「下划线括号 + 字面量」的示例，静态扫描会误当成真实 msgid。
			var msg = isForce
				? _('Force firmware update?') + '\n\n' +
				  _('Even if already up to date, the firmware will be re-downloaded and flashed.') + '\n' +
				  fmt(_('Mode: %s.'), [keepText]) + '\n' +
				  _('Do NOT power off!')
				: _('Start the online firmware upgrade?') + '\n\n' +
				  fmt(_('The system will back up the configuration -> download firmware -> flash (%s) -> reboot.'), [keepText]) + '\n' +
				  _('Do NOT power off!');
			if (!confirm(msg)) return;

			var progArea = document.getElementById('progress-area');
			if (progArea) progArea.style.display = 'block';

			var upgBtn = document.getElementById('btn-upgrade');
			if (upgBtn) upgBtn.style.display = 'none';
			var forceBtn = document.getElementById('btn-force');
			if (forceBtn) forceBtn.style.display = 'none';

			// 假进度条只覆盖备份阶段（5%→25%）；下载起由真实进度/状态驱动
			var steps = [
				{p:5, t:_('Backing up configuration...')},
				{p:25, t:_('Downloading firmware...')}
			];
			var idx = 0;
			var interval = setInterval(function() {
				if (idx < steps.length) {
					updateProgress(steps[idx].p, steps[idx].t);
					updateOutput(steps[idx].t + '\n');
					idx++;
				}
			}, 2000);

			var keepArg = keepConfig ? 'keep' : 'clean';
			fs.exec('/usr/bin/online-upgrade.sh', ['background', keepArg]);

			// 升级流程是否已进入刷写阶段
			var reachedSysupgrade = false;
			// 自进入 sysupgrade 状态后已轮询的次数（用于超时判定）
			var sysupgradePolls = 0;
			// 长时间未重启警告只触发一次
			var sysupWarned = false;
			// 路由器可能已重启：连续多次读取 status 文件失败（连接断开）
			var disconnectStreak = 0;
			var pollFails = 0;
			// 当前进度百分比（真实进度/爬升共用，只增不减）
			var currentPct = 25;
			if (pollTimer) clearInterval(pollTimer);
			pollTimer = setInterval(function() {
				fs.exec('/bin/cat', ['/tmp/online-upgrade-status']).then(function(r) {
					pollFails = 0;
					// 能读到 status 说明路由器尚未重启
					disconnectStreak = 0;
					var status = (r.stdout || '').trim();
					if (status.indexOf('failed:') === 0) {
						// 升级明确失败：停止轮询并显示错误
						clearInterval(interval);
						clearInterval(pollTimer);
						pollTimer = null;
						var errMsg = trFail(status);
						updateOutput('\n' + _('❌ Upgrade failed:') + ' ' + errMsg + '\n');
						var progArea = document.getElementById('progress-area');
						if (progArea) progArea.style.display = 'none';
						var btnCheck = document.getElementById('btn-check');
						if (btnCheck) { btnCheck.disabled = false; btnCheck.textContent = _('Check Update'); }
						var forceBtn = document.getElementById('btn-force');
						if (forceBtn) forceBtn.style.display = 'inline-block';
					} else if (status.indexOf('downloading') === 0) {
						// 下载阶段：按真实字节数推进 25%→55%（status 格式 downloading:总字节数）
						var parts = status.split(':');
						var total = parseInt(parts[1], 10);
						if (total > 0) {
							fs.exec('/bin/sh', ['-c', 'for f in /tmp/firmware.*; do [ -f "$f" ] && wc -c < "$f"; done 2>/dev/null | sort -n | tail -1']).then(function(sr) {
								var got = parseInt((sr.stdout || '').trim(), 10);
								if (got > 0) {
									var pct = 25 + Math.min(30, Math.floor(got / total * 30));
									if (pct > currentPct) {
										currentPct = pct;
										updateProgress(pct, fmt(_('Downloading firmware... %s MB / %s MB'), [Math.floor(got / 1048576), Math.floor(total / 1048576)]));
									}
								}
							}).catch(function() {});
						} else if (currentPct < 54) {
							// 总大小未知时缓慢爬升，封顶 54%
							currentPct++;
							updateProgress(currentPct, _('Downloading firmware...'));
						}
					} else if (status.indexOf('downloaded') === 0) {
						if (currentPct < 60) {
							currentPct = 60;
							updateProgress(60, _('Firmware downloaded, preparing to flash...'));
						}
					} else if (status.indexOf('saving_ts') === 0) {
						if (currentPct < 65) {
							currentPct = 65;
							updateProgress(65, _('Recording version info and creating a backup...'));
						}
					} else if (status.indexOf('sysupgrade') === 0) {
						// 已进入刷写阶段：不立即弹重启框，继续轮询等待路由器真正重启
						if (!reachedSysupgrade) {
							reachedSysupgrade = true;
							currentPct = 75;
							updateProgress(75, _('Flashing firmware, the configuration will be restored automatically!'));
							updateOutput(_('Entering the flashing stage...') + '\n');
						} else if (currentPct < 95) {
							// 刷写期间缓慢爬升，封顶 95%，断连确认后才跳 100%
							currentPct += 2;
							if (currentPct > 95) currentPct = 95;
							updateProgress(currentPct, _('Flashing firmware, do NOT power off...'));
						}
						sysupgradePolls++;
						if (sysupgradePolls > 40 && !sysupWarned) {
							// 进入刷写约 120 秒仍在线，可能失败（只警告一次）
							sysupWarned = true;
							fs.exec('/bin/cat', ['/tmp/online-upgrade.log']).then(function(rl) {
								var last = (rl.stdout || '').split('\n').slice(-5).join('\n');
								updateOutput('\n' + _('⚠️ Flashing started but the router has not rebooted for a long time; it may have failed:') + '\n' + last + '\n');
							});
						}
					} else {
						// backing_up / 空 等
						sysupgradePolls = 0;
					}
				}).catch(function() {
					// 读取失败：可能是路由器正在重启导致连接断开
					disconnectStreak++;
					if (reachedSysupgrade && disconnectStreak >= 2) {
						clearInterval(interval);
						clearInterval(pollTimer);
						pollTimer = null;
						showRebootOverlay();
					} else {
						pollFails++;
					}
				});
			}, 3000);
		}

		function runUpgrade() { startUpgrade(false, true); }
		function runForceUpgrade() { startUpgrade(true, true); }
		function runUpgradeClean() { startUpgrade(false, false); }
		function runForceUpgradeClean() { startUpgrade(true, false); }

		function runBackup() {
			updateOutput(_('Creating configuration backup...') + '\n');
			fs.exec('/usr/bin/online-upgrade.sh', ['backup']).then(function(r) {
				updateOutput(r.stdout + (r.stderr ? '\n' + r.stderr : '') + '\n');
				// 刷新备份信息
				refreshBackupInfo();
			}).catch(function(e) {
				updateOutput(_('❌ Backup failed:') + ' ' + e.message + '\n');
			});
		}

		function refreshBackupInfo() {
			// 刷新备份文件信息显示
			fs.exec('/bin/sh', ['-c', "ls -t /root/pre-upgrade-backup-*.tar.gz 2>/dev/null | head -1 | while read f; do echo \"$f $(date -r \"$f\" '+%Y-%m-%d %H:%M:%S') $(du -h \"$f\" | cut -f1)\"; done"]).then(function(r) {
				var hint = document.getElementById('backup-hint');
				var dlBtn = document.getElementById('btn-download');
				if (!hint) return;
				var output = (r.stdout || '').trim();
				if (output) {
					var parts = output.split(' ');
					var name = parts[0].split('/').pop();
					var ts = parts[1] + ' ' + parts[2];
					var size = parts[3] || '';
					hint.innerHTML = '';
					hint.style.color = '#4CAF50';
					var link = E('a', {
						href: '/cgi-bin/luci/admin/system/online_upgrade/download',
						style: 'color:#4CAF50;text-decoration:none;',
						target: '_blank'
					}, fmt(_('✅ Backup file: %s | %s | %s'), [name, ts, size]));
					hint.appendChild(link);
					if (dlBtn) dlBtn.style.display = 'inline-block';
				} else {
					fs.exec('/bin/sh', ['-c', 'date -r /etc/config/sysupgrade.tgz 2>/dev/null || echo ""']).then(function(r2) {
						var ts2 = (r2.stdout || '').trim();
						if (ts2) {
							hint.textContent = fmt(_('⚠️ Config backup timestamp %s (legacy backup)'), [ts2]);
							hint.style.color = '#ff9800';
						} else {
							hint.textContent = _('⚠️ No backup file');
							hint.style.color = '#999';
						}
					});
				}
			});
		}

		function autoRestore() {
			fs.exec('/bin/sh', ['-c', 'ls -t /root/pre-upgrade-backup-*.tar.gz 2>/dev/null | head -1']).then(function(r) {
				var latestBackup = (r.stdout || '').trim();
				if (latestBackup) {
					if (!confirm(_('Restore the configuration from a backup?') + '\n\n' +
						fmt(_('Backup file: %s'), [latestBackup]) + '\n\n' +
						_('sysupgrade will use this backup to restore all configuration (network, WiFi, firewall, etc.).'))) return;
					updateOutput(_('Restoring configuration (using sysupgrade -f)...') + '\n');
					fs.exec('/bin/sh', ['-c', 'sysupgrade -f "' + latestBackup + '" && echo OK || echo FAIL']).then(function(r2) {
						if (r2.stderr) updateOutput(_('Warning:') + ' ' + r2.stderr + '\n');
						var ok = (r2.stdout || '').indexOf('OK') >= 0;
						if (ok) {
							updateOutput(_('✅ Configuration restored. Reboot the router to apply it.') + '\n');
							ui.addNotification(null, E('p', fmt(_('✅ Configuration restored from %s'), [latestBackup])), 'info');
						} else {
							updateOutput(_('❌ Restore failed') + '\n');
						}
					});
				} else {
					updateOutput(_('No backup found under /root/, trying /etc/config/sysupgrade.tgz...') + '\n');
					fs.exec('/bin/sh', ['-c', 'cd / && tar xzf /etc/config/sysupgrade.tgz etc/config/ 2>/dev/null && echo OK || echo FAIL']).then(function(r3) {
						var ok = (r3.stdout || '').indexOf('OK') >= 0;
						updateOutput(ok ? _('✅ Configuration partially restored from /etc/config/sysupgrade.tgz') + '\n' + _('Reboot or re-apply the configuration.') + '\n' : _('❌ Restore failed, no backup file found') + '\n');
						if (ok) ui.addNotification(null, E('p', _('Configuration partially restored from /etc/config/sysupgrade.tgz')), 'info');
					});
				}
			});
		}

		function manualRestore() {
			// 手动恢复（从本地上传备份文件）
			var fileInput = document.getElementById('manual-backup-file');
			if (!fileInput) return;
			fileInput.click();
		}

		function deleteBackups() {
			// 删除 /root/ 下的所有备份文件
			fs.exec('/bin/sh', ['-c', 'ls /root/pre-upgrade-backup-*.tar.gz 2>/dev/null']).then(function(r) {
				var files = (r.stdout || '').trim();
				if (!files) {
					ui.addNotification(null, E('p', _('No backup files to delete')), 'info');
					return;
				}
				var names = files.split('\n').map(function(f) { return f.split('/').pop(); });
				if (!confirm(_('Delete all of the following backup files?') + '\n\n' + names.join('\n') + '\n\n' + _('This cannot be undone!'))) return;
				fs.exec('/bin/sh', ['-c', 'rm -f /root/pre-upgrade-backup-*.tar.gz && echo OK']).then(function(r2) {
					var ok = (r2.stdout || '').indexOf('OK') >= 0;
					updateOutput(ok ? fmt(_('✅ Deleted %s backup file(s)'), [names.length]) + '\n' : _('❌ Failed to delete the backup files') + '\n');
					if (ok) {
						ui.addNotification(null, E('p', _('✅ All backup files deleted')), 'info');
						refreshBackupInfo();
					}
				});
			});
		}

		// 文件选择后的上传恢复处理
		function handleManualBackupFile(evt) {
			var file = evt.target.files[0];
			if (!file) return;
			evt.target.value = ''; // 清空以便再次选择同一文件

			if (!file.name.match(/\.(tar\.gz|tgz|gz)$/i)) {
				updateOutput(_('❌ Please choose a .tar.gz backup file') + '\n');
				return;
			}

			if (!confirm(_('Restore the configuration from a local file?') + '\n\n' +
				fmt(_('File: %s (%s MB)'), [file.name, (file.size / 1024 / 1024).toFixed(1)]) + '\n\n' +
				_('The file will be uploaded to the router and restored.'))) return;

			updateOutput(fmt(_('Uploading backup file (%s)...'), [file.name]) + '\n');

			var reader = new FileReader();
			reader.onload = function(e) {
				var arrayBuffer = e.target.result;

				updateOutput(_('Restoring...') + '\n');
				fetch('/cgi-bin/online-upgrade-restore', {
					method: 'POST',
					headers: { 'Content-Type': 'application/octet-stream' },
					body: arrayBuffer
				}).then(function(resp) {
					return resp.text();
				}).then(function(text) {
					var isOk = text.indexOf('OK:') === 0;
					// CGI 返回英文协议串（OK:/ERROR: + 英文说明），此处按当前语言渲染
					var msg = _(text.replace(/^(OK|ERROR):/, '').trim());
					updateOutput((isOk ? '✅ ' : '❌ ') + msg + '\n');
					if (isOk) {
						ui.addNotification(null, E('p', _('✅ Configuration restored from the uploaded backup file')), 'info');
					}
				}).catch(function(err) {
					updateOutput(_('❌ Upload failed:') + ' ' + err.message + '\n');
				});
			};
			reader.readAsArrayBuffer(file);
		}

		// 输出框：过滤协议行（RESULT=...），其余逐行翻译（整行命中优先，其次翻译行内已知键）。
		// 传入的文本若已是译文，_() 查不到即原样返回，不会二次翻译。
		function updateOutput(t) {
			var el = document.getElementById('upgrade-result');
			if (!el) return;
			el.style.display = 'block';
			el.textContent += String(t).split('\n').map(function(l) {
				return /^RESULT=/.test(l) ? '' : trLine(l);
			}).join('\n');
		}

		function parseUrl() {
			var url = document.getElementById('cfg-url').value.trim();
			var m = url.match(/github\.com\/([^\/]+\/[^\/]+)\/releases\/tag\/([^\/\s?#]+)/);
			if (m) {
				document.getElementById('cfg-repo').value = m[1];
				document.getElementById('cfg-tag').value = m[2];
				var direct = document.getElementById('cfg-direct-url');
				if (direct) direct.value = '';
				ui.addNotification(null, E('p', fmt(_('Parsed: repository=%s, tag=%s'), [m[1], m[2]])), 'info');
			} else {
				ui.addNotification(null, E('p', _('Invalid URL format')));
			}
		}

		function saveCfg() {
			var g = function(id) { return (document.getElementById(id) || {}).value || ''; };
			var cmd = "uci set online-upgrade.settings.repo='" + g('cfg-repo').replace(/'/g,"'\\''") + "' && uci set online-upgrade.settings.tag='" + g('cfg-tag').replace(/'/g,"'\\''") + "' && uci set online-upgrade.settings.direct_url='" + g('cfg-direct-url').replace(/'/g,"'\\''") + "' && uci set online-upgrade.settings.proxy='" + g('cfg-proxy').replace(/'/g,"'\\''") + "' && uci set online-upgrade.settings.reconnect_hosts='" + g('cfg-reconnect-hosts').replace(/'/g,"'\\''") + "' && uci commit online-upgrade";
			fs.exec('/bin/sh', ['-c', cmd]).then(function() {
				ui.addNotification(null, E('p', _('Configuration saved')), 'info');
			});
		}

		// 读取当前版本和备份状态
		setTimeout(function() {
			fs.exec('/bin/cat', ['/etc/openwrt_release']).then(function(r) {
				var distro = '';
				var lines = (r.stdout || '').split('\n');
				for (var i = 0; i < lines.length; i++) {
					var m = lines[i].match(/DISTRIB_ID='([^']+)'/);
					if (m) { distro = m[1]; var el = document.getElementById('cur-sys'); if (el) el.textContent = m[1] + ' '; }
					m = lines[i].match(/DISTRIB_RELEASE='([^']+)'/);
					if (m) { var el = document.getElementById('cur-ver'); if (el) el.textContent = m[1]; }
					m = lines[i].match(/DISTRIB_REVISION='r?([^']+)'/);
					if (m) { var el = document.getElementById('cur-rev'); if (el) el.textContent = 'r' + m[1]; }
				}
				// 非 ImmortalWrt（如 OpenWrt）时，清空默认 ImmortalWrt 发布源，避免误配
				if (distro && !/immortalwrt/i.test(distro)) {
					var urlEl = document.getElementById('cfg-url');
					if (urlEl && urlEl.value.indexOf('owner/repo') >= 0) {
						urlEl.value = '';
						urlEl.placeholder = 'https://github.com/owner/repo/releases/tag/tag';
					}
					var repoEl = document.getElementById('cfg-repo');
					if (repoEl && repoEl.value === 'owner/repo') repoEl.value = '';
					var tagEl = document.getElementById('cfg-tag');
					if (tagEl && tagEl.value === 'tag') tagEl.value = '';
				}
			});
			// 取重连候选地址快照（必须在路由器下线前读好——下线后无法再执行 uci）
			fs.exec('/bin/sh', ['-c', 'uci -q get online-upgrade.settings.reconnect_hosts 2>/dev/null']).then(function(r) {
				reconnectHosts = (r.stdout || '').trim() || DEFAULT_RECONNECT_HOSTS;
				var el = document.getElementById('cfg-reconnect-hosts');
				if (el) el.value = reconnectHosts;
			});
			refreshBackupInfo();
		}, 100);

		// ======== 构建页面 ========
		return E('div', {'class': 'cbi-map'}, [
			E('h2', {'class': 'cbi-page-title'}, _('Firmware Online Upgrade')),

			// 状态卡片
			E('div', {'class': 'cbi-section', style: 'margin-bottom:16px;padding:20px;'}, [
				E('div', {style: 'font-size:18px;font-weight:600;margin-bottom:12px;'}, [
					E('span', {style: 'display:inline-block;width:12px;height:12px;border-radius:50%;background:#4CAF50;margin-right:8px;'}),
					_('Firmware Status')
				]),
				E('div', {style: 'font-size:14px;margin-bottom:12px;'}, [
					E('div', {style: 'padding:4px 0;'}, [
						E('span', {style: 'color:#666;display:inline-block;width:80px;'}, _('Current version')),
						E('span', {id: 'cur-sys', style: 'font-weight:600;'}, _('Detecting...')),
						E('span', {id: 'cur-ver', style: 'font-weight:600;'}, _('Loading...')),
						E('span', {id: 'cur-rev', style: 'color:#888;margin-left:4px;font-size:12px;'}, '')
					]),
					E('div', {style: 'padding:4px 0;'}, [
						E('span', {style: 'color:#666;display:inline-block;width:80px;'}, _('Latest version')),
						E('span', {id: 'latest-ver'}, '-'),
						E('span', {id: 'latest-size', style: 'color:#888;margin-left:8px;font-size:12px;'}, '')
					]),
					E('div', {style: 'padding:4px 0;', id: 'new-ver-row'}, [
						E('span', {style: 'color:#666;display:inline-block;width:80px;'}, _('Firmware version')),
						E('span', {id: 'new-ver', style: 'font-weight:600;'}, '-'),
						E('span', {id: 'check-reason', style: 'color:#888;margin-left:8px;font-size:12px;'}, '')
					])
				]),
				E('div', {style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;'}, [
					E('button', {id: 'btn-check', class: 'btn cbi-button-action', click: runCheck}, _('Check Update')),
					E('button', {id: 'btn-upgrade', class: 'btn cbi-button-action important', style: 'display:none;background:#4CAF50;border-color:#4CAF50;', click: runUpgrade}, _('Upgrade Now')),
					E('button', {id: 'btn-force', class: 'btn cbi-button', style: 'padding:7px 14px;border-radius:4px;cursor:pointer;font-size:12px;', click: runForceUpgrade}, _('Force Update')),
					E('span', {id: 'check-result', style: 'color:#888;font-size:12px;margin-left:4px;'}, '')
					]),
				E('div', {style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px;'}, [
					E('span', {style: 'color:#666;font-size:12px;margin-right:4px;'}, _('Without keeping system configuration:')),
					E('button', {id: 'btn-upgrade-clean', class: 'btn cbi-button', style: 'display:none;padding:7px 14px;border-radius:4px;cursor:pointer;font-size:12px;border:1px solid #ff9800;color:#ff9800;background:transparent;', click: runUpgradeClean}, _('Upgrade Now (clean)')),
					E('button', {id: 'btn-force-clean', class: 'btn cbi-button', style: 'padding:7px 14px;border-radius:4px;cursor:pointer;font-size:12px;border:1px solid #ff9800;color:#ff9800;background:transparent;', click: runForceUpgradeClean}, _('Force Update (clean)'))
				])
					]),

					// 备份 & 恢复卡片
					E('div', {'class': 'cbi-section', style: 'margin-bottom:16px;padding:20px;'}, [
					E('div', {style: 'font-size:16px;font-weight:600;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid #eee;display:flex;align-items:center;gap:8px;'}, [
					E('span', {style: 'font-size:18px;'}, '💾'),
					_('Backup & Restore')
					]),
					E('div', {style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px;'}, [
					E('button', {id: 'btn-backup', class: 'btn cbi-button', style: 'padding:7px 14px;border-radius:4px;cursor:pointer;font-size:12px;border:1px solid #2196F3;color:#2196F3;background:transparent;', click: runBackup, title: _('Create a configuration backup under /root/')}, _('📦 Create Backup')),
					E('button', {id: 'btn-download', class: 'btn cbi-button', style: 'display:none;padding:7px 14px;border-radius:4px;cursor:pointer;font-size:12px;border:1px solid #4CAF50;color:#4CAF50;background:transparent;', click: function() { var p = window.location.pathname.match(/^\/.*\/admin/) || ['/cgi-bin/luci/admin']; var b = p[0].replace('/admin', ''); window.open(b + '/admin/system/online_upgrade/download', '_blank'); }}, _('⬇ Download Backup')),
					E('button', {id: 'btn-auto-restore', class: 'btn cbi-button', style: 'padding:7px 14px;border-radius:4px;cursor:pointer;font-size:12px;border:1px solid #ff9800;color:#ff9800;background:transparent;', click: autoRestore, title: _('Restore from a backup file stored on the router')}, _('🔄 Auto Restore')),
					E('button', {id: 'btn-manual-restore', class: 'btn cbi-button', style: 'padding:7px 14px;border-radius:4px;cursor:pointer;font-size:12px;border:1px solid #e91e63;color:#e91e63;background:transparent;', click: manualRestore, title: _('Restore from a backup file uploaded from this computer')}, _('📂 Manual Restore')),
					E('button', {id: 'btn-delete-backups', class: 'btn cbi-button', style: 'padding:7px 14px;border-radius:4px;cursor:pointer;font-size:12px;border:1px solid #f44336;color:#f44336;background:transparent;', click: deleteBackups, title: _('Delete all backup files under /root/')}, _('🗑 Delete Backups')),
					E('input', {id: 'manual-backup-file', type: 'file', accept: '.tar.gz,.tgz,.gz', style: 'display:none', change: handleManualBackupFile})
					]),
					E('div', {id: 'backup-hint', style: 'color:#999;font-size:12px;padding:4px 0;'}, _('Checking status...'))
					]),

			// 仓库配置
			E('div', {'class': 'cbi-section', style: 'margin-bottom:16px;padding:20px;'}, [
				E('div', {style: 'font-size:16px;font-weight:600;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid #eee;'}, _('Repository')),
				E('div', {style: 'display:flex;flex-direction:column;gap:10px;'}, [
					E('div', {style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;'}, [
						E('label', {style: 'min-width:160px;font-size:13px;color:#555;font-weight:500;'}, _('Firmware image URL')),
						E('div', {style: 'flex:1;min-width:200px;'}, [
							E('input', {id: 'cfg-direct-url', type: 'text', style: 'width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:4px;font-size:13px;background:var(--input-bg,transparent);', placeholder: 'https://example.com/firmware.img.gz'})
						])
					]),
					E('div', {style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;'}, [
						E('label', {style: 'min-width:160px;font-size:13px;color:#555;font-weight:500;'}, _('GitHub Release Tag URL')),
						E('div', {style: 'flex:1;min-width:200px;display:flex;align-items:center;gap:6px;'}, [
							E('input', {id: 'cfg-url', type: 'text', style: 'flex:1;padding:7px 10px;border:1px solid #ddd;border-radius:4px;font-size:13px;background:var(--input-bg,transparent);', placeholder: 'https://github.com/owner/repo/releases/tag/tag'}),
							E('button', {class: 'btn cbi-button', style: 'padding:7px 14px;border-radius:4px;cursor:pointer;', click: parseUrl}, _('Parse'))
						])
					]),

					E('div', {style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;'}, [
						E('label', {style: 'min-width:160px;font-size:13px;color:#555;font-weight:500;'}, _('Download proxy (optional)')),
						E('input', {id: 'cfg-proxy', type: 'text', style: 'flex:1;min-width:200px;padding:7px 10px;border:1px solid #ddd;border-radius:4px;font-size:13px;background:var(--input-bg,transparent);', placeholder: 'https://ghfast.top/'})
					]),
					E('div', {style: 'display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;'}, [
						E('label', {style: 'min-width:160px;font-size:13px;color:#555;font-weight:500;padding-top:8px;'}, _('Reconnect addresses')),
						E('div', {style: 'flex:1;min-width:200px;'}, [
							E('input', {id: 'cfg-reconnect-hosts', type: 'text', style: 'width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:4px;font-size:13px;background:var(--input-bg,transparent);', placeholder: DEFAULT_RECONNECT_HOSTS}),
							E('div', {style: 'font-size:12px;color:#888;margin-top:4px;'}, _('Candidate addresses used to reconnect automatically after a reboot or IP change (space-separated; host or host:port)'))
						])
					]),
					E('input', {id: 'cfg-repo', type: 'hidden'}),
					E('input', {id: 'cfg-tag', type: 'hidden'})
				]),
				E('div', {style: 'font-size:12px;color:#b45309;background:#fffbeb;border:1px solid #fde68a;border-radius:4px;padding:8px 10px;'}, _("Note: the firmware image URL takes priority over the GitHub Release Tag URL. In direct-URL mode the version is not checked - use \"Force Update\" to flash directly. A GitHub Release Tag URL must be parsed with \"Parse\", and both take effect only after \"Save Configuration\".")),
				E('div', {style: 'margin-top:14px;text-align:right;'}, [
					E('button', {class: 'btn cbi-button-save', style: 'padding:7px 20px;border-radius:4px;cursor:pointer;', click: saveCfg}, _('Save Configuration'))
				])
			]),

			// 进度条
			E('div', {id: 'progress-area', style: 'display:none;margin-bottom:16px;'}, [
				E('div', {'class': 'cbi-section', style: 'padding:20px;'}, [
					E('div', {style: 'font-size:14px;font-weight:600;margin-bottom:10px;'}, _('Upgrade Progress')),
					E('div', {style: 'height:24px;background:#e9ecef;border-radius:12px;overflow:hidden;position:relative;'}, [
						E('div', {id: 'progress-bar', style: 'width:0%;height:100%;background:linear-gradient(90deg,#4CAF50,#8BC34A);border-radius:12px;transition:width 0.5s ease;'}),
						E('div', {id: 'progress-label', style: 'position:absolute;top:0;left:0;right:0;height:24px;line-height:24px;text-align:center;font-size:12px;font-weight:600;color:#333;'}, '0%')
					]),
					E('div', {id: 'progress-text', style: 'margin-top:8px;font-size:13px;color:#666;'}, '')
				])
			]),

			// 结果
			E('pre', {id: 'upgrade-result', style: 'background:var(--cbi-section-bg,#1e1e1e);color:#d4d4d4;padding:20px;border-radius:6px;overflow:auto;max-height:400px;font-size:13px;white-space:pre-wrap;display:none;border:1px solid var(--cbi-section-border,#ddd);box-shadow:0 1px 4px rgba(0,0,0,0.06);box-sizing:border-box;width:100%;'}, '')
		]);
	}
});
