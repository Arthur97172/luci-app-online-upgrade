# luci-app-online-upgrade

ImmortalWrt / OpenWrt LuCI 插件 - 从 GitHub Releases 在线升级固件。

![Screenshot](screenshot.png)

## 功能

- **双模式固件源**：支持 GitHub Release Tag 地址自动解析，也支持直接输入固件镜像下载地址，优先级以固件镜像下载地址为准
- **智能检测与升级**：自动检测固件更新，一键在线升级；支持保留系统配置升级，也支持干净升级，仅保留本插件
- **下载加速**：支持 GitHub 下载加速代理，可自定义代理地址，提升下载速度和稳定性
- **安全备份**：升级前自动备份配置到 `/root/pre-upgrade-backup-*.tar.gz`，刷写后自动恢复；同时提供手动备份、下载、恢复、删除功能
- **强制更新**：即使当前已是最新版本，也可强制重新下载并刷写固件
- **系统自适应**：自动识别运行系统 ImmortalWrt / OpenWrt，并自动检测路由器架构匹配对应固件文件
- **多格式兼容**：兼容 `.img.gz` / `.img` / `.itb`（ARM64 等）/ `.bin` 等多种固件格式
- **SNAPSHOT 支持**：支持 SNAPSHOT 快照固件，通过修订号 `r36350` 判断新旧，文件名无修订号时回退到编译时间戳
- **多包格式**：同时编译 `.ipk` (opkg) 和 `.apk` (apk) 两种格式，兼容 OpenWrt 23.05 及更早版本与 25.12+ 版本

## 使用方法

1. 安装后，在 LuCI 菜单 **系统 → 在线升级** 进入
2. **固件源配置**：任选其一
   - 填入 GitHub Release Tag 地址，点击 **解析** 自动获取仓库和标签
   - 或直接填入固件镜像下载地址，优先级高于 GitHub Release Tag 地址
   - 可选填入下载代理以加速 GitHub 下载
3. 点击 **保存配置**
4. 点击 **检查更新** 查看最新固件
5. 点击 **立即升级** 或 **强制更新** 开始升级，支持保留/干净两种模式
6. 路由器将自动备份配置 → 下载固件 → 刷写 → 重启

## 编译

```bash
# 将本插件放到 openwrt/package/luci-app-online-upgrade/
cd openwrt
make package/luci-app-online-upgrade/compile V=s
```

## 手动安装

**opkg (OpenWrt/ImmortalWrt 23.05 及更早):**
```bash
opkg install luci-app-online-upgrade_1.1.0_all.ipk
```

**apk (OpenWrt/ImmortalWrt 25.12+):**
```bash
apk add --allow-untrusted luci-app-online-upgrade-1.1.0-r7.apk
```

## 依赖

- curl
- jsonfilter
- LuCI (luci-base)

## 🌟 Star戳一戳，好运加满！😆
> **"点过 `Star` 的朋友，颜值与智慧双双在线！✨"**
> 
> **"您的每一个⭐️，都是开源土壤里的一缕阳光，让灵感发芽，让创造生长~"**

## 🎉 Thanks [![](https://img.shields.io/badge/-Thanks-FFFFFF.svg)](#-Thanks-)
- [gooyjq/luci-app-online-upgrade](https://github.com/gooyjq/luci-app-online-upgrade)

本项目基于 gooyjq/luci-app-online-upgrade 克隆而来，特此感谢原仓库作者的辛勤付出！！！
