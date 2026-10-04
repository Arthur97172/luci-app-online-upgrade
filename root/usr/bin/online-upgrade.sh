#!/bin/sh
# =====================================================
# Online Upgrade Script for ImmortalWrt/OpenWrt
# Part of luci-app-online-upgrade
# =====================================================
#
# Usage:
#   online-upgrade.sh check              Check for firmware updates
#   online-upgrade.sh upgrade            Backup + download + sysupgrade
#   online-upgrade.sh background         Run upgrade in background (for LuCI)
#   online-upgrade.sh backup             Only backup
#   online-upgrade.sh reset              Reset update check record

CONFIG_FILE="/etc/config/online-upgrade"

# Read UCI config
get_uci() { uci -q get "online-upgrade.settings.$1" 2>/dev/null; }
REPO="$(get_uci repo)"
TAG="$(get_uci tag)"
DIRECT_URL="$(get_uci direct_url)"
PROXY="$(get_uci proxy)"
FW_PATTERN="$(get_uci firmware_pattern)"
KEEP_CONFIG="$(get_uci keep_config)"

# ===== 自动识别系统发行版与架构 =====
# 兼容 ImmortalWrt / OpenWrt 及衍生系统
detect_distro() {
    local id="$(grep -E '^DISTRIB_ID=' /etc/openwrt_release 2>/dev/null | cut -d"'" -f2)"
    case "$(echo "$id" | tr 'A-Z' 'a-z')" in
        *immortalwrt*) echo "immortalwrt" ;;
        *openwrt*)     echo "openwrt" ;;
        *)
            # 兜底：按存在性判断
            if [ -f /etc/immortalwrt_release ]; then
                echo "immortalwrt"
            elif [ -f /etc/openwrt_release ]; then
                echo "openwrt"
            else
                echo "unknown"
            fi
            ;;
    esac
}
detect_arch() {
    uname -m 2>/dev/null || echo "unknown"
}

DISTRO="$(detect_distro)"
ARCH="$(detect_arch)"

# 发行版相关默认仓库/标签（仅当用户未配置时使用）
#  ImmortalWrt / OpenWrt：均需用户显式配置仓库与标签，无内置默认源
if [ "$DISTRO" = "immortalwrt" ]; then
    [ -z "$REPO" ] && REPO=""
    [ -z "$TAG" ] && TAG=""
else
    [ -z "$REPO" ] && REPO=""
    [ -z "$TAG" ] && TAG=""
fi
[ -z "$PROXY" ] && PROXY="https://ghfast.top/"
[ -z "$FW_PATTERN" ] && FW_PATTERN="auto"

# 直链模式：优先级高于 GitHub repo/tag
SKIP_GITHUB=0
if [ -n "$DIRECT_URL" ]; then
    SKIP_GITHUB=1
    DOWNLOAD_URL="$DIRECT_URL"
    # 去掉查询参数取文件名
    FILE_NAME="$(basename "${DOWNLOAD_URL%%\?*}")"
    # 绝对 URL 不自动拼接代理；相对路径才拼接
    case "$DOWNLOAD_URL" in
        http://*|https://*)
            FULL_URL="$DOWNLOAD_URL"
            ;;
        *)
            FULL_URL="${PROXY}${DOWNLOAD_URL}"
            ;;
    esac
    # 直链模式下版本信息为空，check 直接提示
    ASSET_UPDATED="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    ASSET_SIZE=""
    FW_VERSION_RELEASE=""
fi

API_URL="https://api.github.com/repos/${REPO}/releases/tags/${TAG}"
TMP_JSON="/tmp/release.json"

MODE="${1:-check}"
KEEP_MODE="${2:-keep}"

# 判定结果协议行（机器可读，前端依赖它决定按钮显隐与提示文案，不参与展示翻译）
#   RESULT=new          有新固件
#   RESULT=latest       已是最新
#   RESULT=ratelimited  GitHub API 限速（403）
#   RESULT=error        其它错误
emit_result() { echo "RESULT=$1"; }

echo "========================================"
echo "  Firmware Online Upgrade"
if [ "$MODE" = "backup" ] || [ "$MODE" = "--backup" ]; then
    echo "  System: ${DISTRO}"
    echo "  Architecture: ${ARCH}"
elif [ "$SKIP_GITHUB" = "1" ]; then
    echo "  Architecture: ${ARCH}"
    echo "  Firmware image URL: ${DOWNLOAD_URL}"
else
    echo "  Architecture: ${ARCH}"
    echo "  Repository: ${REPO}"
    echo "  Tag: ${TAG}"
fi
echo "========================================"

# ===== 工具函数 =====
utc_to_local() {
    local utc_str="$1"
    local clean=$(echo "$utc_str" | sed 's/T/ /' | sed 's/Z//')
    local epoch=$(date -d "$clean" +%s 2>/dev/null)
    [ -z "$epoch" ] || [ "$epoch" = "0" ] && { echo "$utc_str"; return; }
    epoch=$((epoch + 8 * 3600))
    date -d "@${epoch}" +"%Y-%m-%d %H:%M:%S" 2>/dev/null || echo "$utc_str"
}

# 提取当前固件版本号（数值比较用）
get_current_version() {
    local ver=$(grep "DISTRIB_REVISION" /etc/openwrt_release 2>/dev/null | cut -d"'" -f2 | sed 's/r//')
    [ -z "$ver" ] && ver="0"
    echo "$ver"
}

# 提取固件版本号（从文件名提取，如 immortalwrt-25.12.0-x86-64-...）
extract_fw_version() {
    local filename="$1"
    # 匹配如 25.12.0, 23.05.3 等版本号
    local fwver=$(echo "$filename" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
    echo "${fwver:-0}"
}

# 提取修订号数字（用于 SNAPSHOT 快照固件判断新旧）
# 支持：r36350 / 36350 / 文件名中的 36350-3a117c0c53 等
extract_revision() {
    local s="$1"
    local rev
    # 优先 r 前缀数字（如 r36350）
    rev=$(echo "$s" | grep -oE 'r[0-9]+' | head -1 | tr -d 'r')
    # 否则取 4-6 位数字段（如 36350 / r37339）
    [ -z "$rev" ] && rev=$(echo "$s" | grep -oE '(^|[-_])[0-9]{4,6}([-_.]|$)' | grep -oE '[0-9]+' | head -1)
    echo "$rev"
}

# 版本号字符串转可比较数值（如 25.12.0 → 251200）
ver_to_num() {
    echo "$1" | awk -F. '{printf "%d%02d%02d", $1, $2, $3}' 2>/dev/null || echo "0"
}

# 对比版本（当前 < 新 返回 0）
is_newer_version() {
    local cur_num=$(ver_to_num "$1")
    local new_num=$(ver_to_num "$2")
    [ "$cur_num" -lt "$new_num" ] 2>/dev/null && return 0 || return 1
}

# 架构关键字（用于优先匹配固件文件名，支持 x86_64 / ARM64 等）
arch_hint() {
    case "$ARCH" in
        x86_64|amd64)          echo "x86-64" ;;
        aarch64|arm64)         echo "aarch64|armv8|rockchip|arm64" ;;
        armv7l|armv7|armv5teb) echo "armv7|armv5|mvebu|ipq|kirkwood|mpc85xx" ;;
        mips|mipsel|mips64)    echo "mips|ramips|octeon|ipq40xx" ;;
        *)                     echo "" ;;
    esac
}

# ===== 后台升级模式 =====
if [ "$MODE" = "background" ] || [ "$MODE" = "--background" ] || [ "$MODE" = "--bg" ]; then
    KEEP_PASS="${2:-keep}"
    setsid /bin/sh "$0" "upgrade" "$KEEP_PASS" </dev/null >/tmp/online-upgrade.log 2>&1 &
    exit 0
fi

# ===== 重置 =====
if [ "$MODE" = "reset" ] || [ "$MODE" = "--reset" ]; then
    echo "Update record has been reset."
    exit 0
fi

# ===== 仅备份 =====
if [ "$MODE" = "backup" ] || [ "$MODE" = "--backup" ]; then
    TS=$(date +%Y%m%d-%H%M%S)
    BAK="/tmp/pre-upgrade-backup-${TS}.tar.gz"
    echo "Creating configuration backup..."
    sysupgrade -b "$BAK"
    if [ $? -eq 0 ] && [ -s "$BAK" ]; then
        cp "$BAK" "/root/pre-upgrade-backup-${TS}.tar.gz"
        echo "Backup created: /root/pre-upgrade-backup-${TS}.tar.gz ($(du -h "$BAK" | cut -f1))"
        echo "Archive contains $(tar tzf "$BAK" 2>/dev/null | wc -l) files"
        echo "Note: sysupgrade will restore this backup automatically via -f"
    else
        echo "Error: backup failed!"
        exit 1
    fi
    exit 0
fi

# ===== 校验仓库配置 =====
if [ "$SKIP_GITHUB" = "1" ]; then
    # 直链模式，跳过仓库校验
    :
elif [ -z "$REPO" ] || [ -z "$TAG" ]; then
    echo ""
    echo "Error: GitHub repository / tag is not configured."
    echo "Current system: ${DISTRO}"
    echo "No default release source is used. Configure it first:"
    echo "      uci set online-upgrade.settings.repo='owner/repo'"
    echo "      uci set online-upgrade.settings.tag='your-release-tag'"
    echo "      uci commit online-upgrade"
    echo "      Or paste a GitHub Release Tag URL in LuCI and click \"Parse\""
    emit_result error
    exit 1
fi

# ===== 获取 Release 信息 =====
if [ "$SKIP_GITHUB" = "1" ]; then
    echo ""
    echo "[1/2] Firmware image URL mode, skipping release lookup"
else
    echo ""
    echo "[1/2] Fetching release information..."
fi
# 固件镜像下载地址模式跳过 GitHub API 请求，避免 repo/tag 为空导致 404
if [ "$SKIP_GITHUB" != "1" ]; then
GITHUB_TOKEN="$(uci -q get online-upgrade.settings.github_token 2>/dev/null)"
if [ -n "$GITHUB_TOKEN" ]; then
    HTTP_CODE=$(curl -sL -H "Authorization: Bearer $GITHUB_TOKEN" -H "User-Agent: curl/online-upgrade" -o "$TMP_JSON" -w "%{http_code}" "$API_URL")
else
    HTTP_CODE=$(curl -sL -H "User-Agent: curl/online-upgrade" -o "$TMP_JSON" -w "%{http_code}" "$API_URL")
fi
if [ "$HTTP_CODE" = "000" ]; then
    echo "Warning: direct GitHub API access failed, retrying through the proxy..."
    PROXY_API="${PROXY}${API_URL}"
    if [ -n "$GITHUB_TOKEN" ]; then
        HTTP_CODE=$(curl -sL -H "Authorization: Bearer $GITHUB_TOKEN" -H "User-Agent: curl/online-upgrade" -o "$TMP_JSON" -w "%{http_code}" "$PROXY_API")
    else
        HTTP_CODE=$(curl -sL -H "User-Agent: curl/online-upgrade" -o "$TMP_JSON" -w "%{http_code}" "$PROXY_API")
    fi
fi
if [ "$HTTP_CODE" = "403" ]; then
    echo "Warning: GitHub API rate limited, waiting before retry..."
    for r in 1 2 3; do
        sleep $((r * 15))
        echo "  Retry attempt ${r}..."
        if [ -n "$GITHUB_TOKEN" ]; then
            HTTP_CODE=$(curl -sL -H "Authorization: Bearer $GITHUB_TOKEN" -H "User-Agent: curl/online-upgrade" -o "$TMP_JSON" -w "%{http_code}" "$API_URL")
        else
            HTTP_CODE=$(curl -sL -H "User-Agent: curl/online-upgrade" -o "$TMP_JSON" -w "%{http_code}" "$API_URL")
        fi
        [ "$HTTP_CODE" = "200" ] && break
    done
fi
if [ "$HTTP_CODE" = "403" ]; then
    echo "Error: GitHub API rate limit exceeded (60 requests/hour, HTTP 403)"
    echo "Wait an hour and retry, or set github_token to raise the limit to 5000/hour"
    echo "      uci set online-upgrade.settings.github_token='your-token'"
    echo "      uci commit online-upgrade"
    rm -f "$TMP_JSON"
    emit_result ratelimited
    exit 1
elif [ "$HTTP_CODE" != "200" ]; then
    echo "Error: GitHub API returned HTTP $HTTP_CODE"
    rm -f "$TMP_JSON"
    emit_result error
    exit 1
fi
fi

# ===== 查找固件 =====
if [ "$SKIP_GITHUB" != "1" ]; then
# 兼容多种固件格式：*.img.gz / *.img / *.itb（ARM64 等）/ *.bin（部分厂商）
echo ""
echo "[2/2] Looking for the latest firmware..."
FILE_NAMES=$(cat "$TMP_JSON" | jsonfilter -e "@.assets[*].name")

pick_file() {
    local names="$1" f="" hint="" pat="" line=""
    # 先清理每行行尾的 CR / 空白，得到干净的资产名列表（多行）
    clean=$(echo "$names" | tr -d '\r' | sed 's/[[:space:]]*$//')
    # 1) 用户配置的自定义模式
    if [ -n "$FW_PATTERN" ] && [ "$FW_PATTERN" != "auto" ]; then
        f=$(echo "$clean" | grep -E "$FW_PATTERN" | head -1)
        [ -n "$f" ] && { echo "$f"; return; }
    fi
    # 2) 按架构优先匹配（x86-64 / aarch64 / armv7 / mips 等）
    hint="$(arch_hint)"
    if [ -n "$hint" ]; then
        for pat in ".*${hint}.*sysupgrade\\.itb$" ".*${hint}.*\\.itb$" \
                   ".*${hint}.*\\.img\\.gz$" ".*${hint}.*\\.img$" \
                   ".*${hint}.*\\.bin$"; do
            f=$(echo "$clean" | grep -E "$pat" | head -1)
            [ -n "$f" ] && { echo "$f"; break; }
        done
        [ -n "$f" ] && return
    fi
    # 3) 通用匹配（优先级：img.gz > img > sysupgrade.itb > itb > bin）
    for pat in 'combined-efi.*\.img\.gz$' 'combined.*\.img\.gz$' \
               '.*\.img\.gz$' '.*\.img$' \
               '.*sysupgrade\.itb$' '.*\.itb$' \
               '.*sysupgrade\.bin$' '.*\.bin$' \
               '.*combined.*'; do
        f=$(echo "$clean" | grep -E "$pat" | head -1)
        [ -n "$f" ] && { echo "$f"; break; }
    done
    echo "$f"
}

# 取出选中文件名（已去 CR/尾部空白；head -1 兜底保证单行，避免重复行污染）
FILE_NAME=$(pick_file "$FILE_NAMES" | tr -d '\r' | sed 's/[[:space:]]*$//' | head -1)
if [ -z "$FILE_NAME" ]; then
    echo "Error: no matching firmware file found"
    echo "Hint: customize the match pattern in \"Advanced settings -> Firmware pattern\""
    rm -f "$TMP_JSON"
    emit_result error
    exit 1
fi

# 并行提取所有 asset 的字段：每个字段输出为多行，行序与 assets 数组一一对应。
# 这样在“干净名字列表”里定位行号后，用同一行号从其它列表取字段，
# 彻底绕开 jsonfilter 数组下标（busybox 上 0 基/1 基不确定）导致的错位。
ALL_URLS=$(cat "$TMP_JSON" | jsonfilter -e "@.assets[*].browser_download_url")
ALL_UPDATED=$(cat "$TMP_JSON" | jsonfilter -e "@.assets[*].updated_at")
ALL_SIZES=$(cat "$TMP_JSON" | jsonfilter -e "@.assets[*].size")

CLEAN_NAMES=$(echo "$FILE_NAMES" | tr -d '\r' | sed 's/[[:space:]]*$//')
IDX=$(echo "$CLEAN_NAMES" | grep -nxF "$FILE_NAME" | cut -d: -f1 | head -1)
[ -z "$IDX" ] && IDX=1

DOWNLOAD_URL=$(echo "$ALL_URLS" | sed -n "${IDX}p")
ASSET_UPDATED=$(echo "$ALL_UPDATED" | sed -n "${IDX}p")
ASSET_SIZE=$(echo "$ALL_SIZES" | sed -n "${IDX}p")
ASSET_UPDATED_LOCAL=$(utc_to_local "$ASSET_UPDATED")

# 校验下载 URL 是否解析成功（上次故障根因：URL 为空导致下载到 1797 字节垃圾文件）
if [ -z "$DOWNLOAD_URL" ]; then
    echo "Error: could not resolve the firmware download URL (jsonfilter found no browser_download_url)"
    echo "Hint: firmware file name is \"${FILE_NAME}\"; make sure the release really contains it"
    rm -f "$TMP_JSON"
    emit_result error
    exit 1
fi
fi

# 直链模式默认值补全
if [ "$SKIP_GITHUB" = "1" ]; then
    [ -z "$ASSET_UPDATED_LOCAL" ] && ASSET_UPDATED_LOCAL="$(date +"%Y-%m-%d %H:%M:%S")"
    # ASSET_SIZE 保持为空：大小未知时展示层直接省略 "File size" 行，避免引入哨兵字符串
    :
fi

# 提取版本号（从固件文件名）
FW_VERSION_RELEASE=$(extract_fw_version "$FILE_NAME")
rm -f "$TMP_JSON"

# 根据固件扩展名选择正确的临时文件名。
# sysupgrade 会依据扩展名/文件魔数判断是否解压及刷写方式，
# 若把 .itb / .bin 命名为 .img.gz 会导致刷写失败。
case "$FILE_NAME" in
    *.img.gz) FW_EXT="img.gz" ;;
    *.tar.gz) FW_EXT="tar.gz" ;;
    *.itb)    FW_EXT="itb" ;;
    *.img)    FW_EXT="img" ;;
    *.bin)    FW_EXT="bin" ;;
    *.gz)     FW_EXT="gz" ;;
    *)        FW_EXT="${FILE_NAME##*.}" ;;
esac
TMP_FIRMWARE="/tmp/firmware.${FW_EXT}"

# ===== 获取当前固件版本 =====
CURRENT_RELEASE=$(grep "DISTRIB_RELEASE" /etc/openwrt_release 2>/dev/null | cut -d"'" -f2)
CURRENT_REVISION=$(grep "DISTRIB_REVISION" /etc/openwrt_release 2>/dev/null | cut -d"'" -f2 | sed "s/r//")
CURRENT_ID=$(grep "DISTRIB_ID" /etc/openwrt_release 2>/dev/null | cut -d"'" -f2)

# ===== 版本对比（版本号 / SNAPSHOT 修订号 / 时间戳）=====
LAST_TS="$(uci -q get online-upgrade.settings.last_upgrade_ts 2>/dev/null)"
LAST_VERSION="$(uci -q get online-upgrade.settings.last_upgrade_version 2>/dev/null)"

NEW_FIRMWARE=0
# 判定依据以「稳定码|参数1|参数2」形式输出（协议串），展示文案由前端按码渲染，
# 这样 shell 无需关心语言，新增语言也不用改脚本。
REASON_CODE=""
REASON_ARGS=""

# 是否 SNAPSHOT 快照固件（无稳定版本号，改用修订号/时间戳判断新旧）
IS_SNAPSHOT=0
case "$CURRENT_RELEASE" in
    SNAPSHOT|snapshot|*snapshot*) IS_SNAPSHOT=1 ;;
esac

# 当前修订号数值（r36350-3a117c0c53 → 36350）；新固件修订号（从文件名提取）
CURRENT_REV_NUM="$(echo "$CURRENT_REVISION" | grep -oE '[0-9]+' | head -1)"
FW_REV_NUM="$(extract_revision "$FILE_NAME")"

# 判断是否有新固件
if [ -z "$LAST_TS" ] && [ -z "$LAST_VERSION" ]; then
    NEW_FIRMWARE=1
    REASON_CODE="first_check"
elif [ "$IS_SNAPSHOT" = "1" ]; then
    # SNAPSHOT：优先用修订号数值比较，缺失/相等则回退到编译时间戳
    if [ -n "$CURRENT_REV_NUM" ] && [ -n "$FW_REV_NUM" ] && [ "$FW_REV_NUM" -gt "$CURRENT_REV_NUM" ] 2>/dev/null; then
        NEW_FIRMWARE=1
        REASON_CODE="new_snapshot"
        REASON_ARGS="${FW_REV_NUM}|${CURRENT_REV_NUM}"
    elif [ "$ASSET_UPDATED" != "$LAST_TS" ] 2>/dev/null; then
        NEW_FIRMWARE=1
        REASON_CODE="snapshot_time"
        REASON_ARGS="${ASSET_UPDATED_LOCAL}"
    else
        REASON_CODE="latest_snapshot"
    fi
elif [ "$FW_VERSION_RELEASE" != "0" ] && [ "$CURRENT_RELEASE" != "$FW_VERSION_RELEASE" ]; then
    # 基于版本号比较
    if is_newer_version "$CURRENT_RELEASE" "$FW_VERSION_RELEASE"; then
        NEW_FIRMWARE=1
        REASON_CODE="new_version"
        REASON_ARGS="${FW_VERSION_RELEASE}|${CURRENT_RELEASE}"
    elif [ -n "$LAST_VERSION" ] && [ "$LAST_VERSION" != "$FW_VERSION_RELEASE" ]; then
        # 记录的版本号不同但当前已是此版本—可能是重新编译
        NEW_FIRMWARE=1
        REASON_CODE="recompiled"
        REASON_ARGS="${FW_VERSION_RELEASE}"
    else
        REASON_CODE="latest"
        REASON_ARGS="${CURRENT_RELEASE}"
    fi
elif [ "$ASSET_UPDATED" != "$LAST_TS" ] 2>/dev/null; then
    # 版本号相同但时间戳不同—重新编译
    NEW_FIRMWARE=1
    REASON_CODE="recompiled_time"
    REASON_ARGS="${ASSET_UPDATED_LOCAL}"
else
    REASON_CODE="up_to_date"
fi

# ===== 显示信息 =====
CURRENT_ID=$(grep "DISTRIB_ID" /etc/openwrt_release 2>/dev/null | cut -d"'" -f2)
echo ""
echo "============================================"
echo "  Firmware Status"
echo "============================================"
echo "  Current firmware: ${CURRENT_ID} ${CURRENT_RELEASE} (r${CURRENT_REVISION})"
echo "  New firmware version: v${FW_VERSION_RELEASE:-N/A}"
echo "  Latest firmware: ${FILE_NAME}"
# ASSET_SIZE 在直链模式下为空（非数字），直接做算术会报 arithmetic syntax error；
# 大小不可知时整行省略，前端据此不显示后缀（不再使用哨兵字符串）
case "$ASSET_SIZE" in
    ''|*[!0-9]*) SIZE_DISPLAY="" ;;
    *)           SIZE_DISPLAY="$(printf "%.0f MB" $((ASSET_SIZE / 1024 / 1024)))" ;;
esac
[ -n "$SIZE_DISPLAY" ] && echo "  File size: ${SIZE_DISPLAY}"
echo "  Build time: ${ASSET_UPDATED_LOCAL}"
echo "  Reason: ${REASON_CODE}|${REASON_ARGS}"
echo "============================================"
[ "$NEW_FIRMWARE" = "1" ] && echo "" && echo "  >>> New firmware available!"

# 判定结果协议行：前端据此决定按钮显隐（new / latest）
if [ "$NEW_FIRMWARE" = "1" ]; then
    emit_result new
else
    emit_result latest
fi

# ===== 非升级模式直接退出 =====
if [ "$MODE" != "upgrade" ] && [ "$MODE" != "--upgrade" ]; then
    echo ""
    echo "  Upgrade: online-upgrade.sh upgrade"
    exit 0
fi

# ====================================================================
#  升级执行
# ====================================================================
echo ""
echo "============================================"
echo "  [Running upgrade]"
echo "============================================"

# 初始化状态文件
echo "backing_up" > /tmp/online-upgrade-status

# ---- Step 1: 下载固件 ----
FULL_URL="${PROXY}${DOWNLOAD_URL}"
echo ""
echo "Step 1: Downloading firmware..."
DOWNLOAD_SKIP=0
# 仅当已知编译时间戳且缓存文件存在时才考虑跳过（避免 ASSET_UPDATED 为空时误跳过）
if [ -n "$ASSET_UPDATED" ] && [ -f "$TMP_FIRMWARE" ] && [ -f "${TMP_FIRMWARE}.ts" ]; then
    LOCAL_TS=$(cat "${TMP_FIRMWARE}.ts")
    if [ "$LOCAL_TS" = "$ASSET_UPDATED" ]; then
        echo "  Firmware already downloaded, skipping (${ASSET_UPDATED_LOCAL})"
        DOWNLOAD_SKIP=1
    fi
fi
if [ "$DOWNLOAD_SKIP" = "0" ]; then
    echo "downloading" > /tmp/online-upgrade-status
    # 写入固件总大小供前端显示真实下载进度（格式 downloading:字节数）
    # GitHub 模式用 ASSET_SIZE；直链模式 ASSET_SIZE 非数字，通过 HEAD 请求取 Content-Length
    DL_TOTAL=""
    case "$ASSET_SIZE" in
        ''|*[!0-9]*) ;;
        *) DL_TOTAL="$ASSET_SIZE" ;;
    esac
    if [ -z "$DL_TOTAL" ]; then
        DL_TOTAL=$(curl -sIL --max-time 15 "$FULL_URL" 2>/dev/null | grep -i '^content-length:' | tail -1 | tr -dc '0-9')
    fi
    [ -n "$DL_TOTAL" ] && echo "downloading:$DL_TOTAL" > /tmp/online-upgrade-status
    echo "  URL: $(echo "$FULL_URL" | head -c 80)..."
    curl -sL -o "$TMP_FIRMWARE" "$FULL_URL" 2>&1
    CURL_EXIT=$?
    if [ "$CURL_EXIT" -ne 0 ] || [ ! -s "$TMP_FIRMWARE" ]; then
        # 协议：failed:<code>:<args>；展示文案由前端按 code 渲染
        echo "failed:download:$CURL_EXIT" > /tmp/online-upgrade-status
        echo "Error: download failed! (curl exit: $CURL_EXIT)"
        rm -f "$TMP_FIRMWARE"
        exit 1
    fi
    # 校验文件大小与预期一致，防止下载到错误页/被截断的假固件
    # 仅在大小为已知数字时校验（直链模式 ASSET_SIZE 为空，跳过）
    case "$ASSET_SIZE" in
        ''|*[!0-9]*) ;;
        *)
        ACTUAL_SIZE=$(wc -c < "$TMP_FIRMWARE" 2>/dev/null | tr -d ' ')
        if [ "$ACTUAL_SIZE" != "$ASSET_SIZE" ]; then
            echo "failed:size:${ASSET_SIZE}:${ACTUAL_SIZE}" > /tmp/online-upgrade-status
            echo "Error: firmware size mismatch (expected ${ASSET_SIZE} bytes, got ${ACTUAL_SIZE} bytes)"
            echo "Hint: the download may have been intercepted by the proxy or returned an error page; check the PROXY setting"
            rm -f "$TMP_FIRMWARE"
            exit 1
        fi
        ;;
    esac
    echo "$ASSET_UPDATED" > "${TMP_FIRMWARE}.ts"
    echo "  Download complete ($(du -h "$TMP_FIRMWARE" | cut -f1))"
    echo "downloaded" > /tmp/online-upgrade-status
fi

# ---- Step 2: 记录版本信息到 UCI（备份前，确保备份含版本记录）----
echo ""
echo "Step 2: Recording firmware version..."
echo "saving_ts" > /tmp/online-upgrade-status
uci set online-upgrade.settings.last_upgrade_ts="$ASSET_UPDATED"
uci set online-upgrade.settings.last_upgrade_version="${FW_VERSION_RELEASE:-0}"
uci commit online-upgrade
sync
echo "  Recorded version: v${FW_VERSION_RELEASE:-N/A} (${ASSET_UPDATED_LOCAL})"

# ---- Step 3: 创建 sysupgrade 备份（传给 -f 参数）----
TS=$(date +%Y%m%d-%H%M%S)
BACKUP_TMP="/tmp/pre-upgrade-backup-${TS}.tar.gz"
BACKUP_ROOT="/root/pre-upgrade-backup-${TS}.tar.gz"
if [ "$KEEP_MODE" = "keep" ]; then
    echo ""
    echo "Step 3: Creating sysupgrade configuration backup..."
    sysupgrade -b "$BACKUP_TMP"
    if [ $? -ne 0 ] || [ ! -s "$BACKUP_TMP" ]; then
        echo "Error: configuration backup failed!"
        exit 1
    fi
    # 同时保存到 /root/ 作为应急副本
    cp "$BACKUP_TMP" "$BACKUP_ROOT"
    echo "  Backup created: ${BACKUP_ROOT} ($(du -h "$BACKUP_TMP" | cut -f1))"
    echo "  Archive contains $(tar tzf "$BACKUP_TMP" 2>/dev/null | wc -l) files"
else
    echo ""
    echo "Step 3: Creating a minimal backup of this plugin only (clean upgrade, system config not kept)..."
    # 从包管理器查询本插件的全部已安装文件，打成最小归档
    PKG_FILES=$(apk info -L luci-app-online-upgrade 2>/dev/null | grep '^/' || opkg files luci-app-online-upgrade 2>/dev/null | grep '^/')
    # 兜底：包管理器查询失败时使用已知文件清单
    if [ -z "$PKG_FILES" ]; then
        PKG_FILES="/etc/config/online-upgrade
/usr/bin/online-upgrade.sh
/www/cgi-bin/online-upgrade-restore
/lib/upgrade/keep.d/online-upgrade
/etc/uci-defaults/99-online-upgrade
/etc/uci-defaults/90-online-upgrade-auto
/usr/lib/lua/luci/controller/admin_system/online_upgrade.lua
/usr/share/luci/menu.d/luci-app-online-upgrade.json
/usr/share/rpcd/acl.d/luci-app-online-upgrade.json
/www/luci-static/resources/view/system/online-upgrade.js"
    fi
    # 过滤掉已不存在的文件（如已被删除的 uci-defaults 脚本），避免 tar 报错
    EXISTING_FILES=""
    for f in $PKG_FILES; do
        [ -e "$f" ] && EXISTING_FILES="$EXISTING_FILES $f"
    done
    # 保存包管理器注册信息，供升级后恢复注册（避免 opkg/apk 查不到本包）
    mkdir -p /etc/online-upgrade-pkgdb
    if command -v apk >/dev/null 2>&1 && apk info -e luci-app-online-upgrade >/dev/null 2>&1; then
        awk -v RS='' '/^P:luci-app-online-upgrade$/' /lib/apk/db/installed > /etc/online-upgrade-pkgdb/apk-installed 2>/dev/null
    elif command -v opkg >/dev/null 2>&1; then
        opkg status luci-app-online-upgrade > /etc/online-upgrade-pkgdb/opkg-status 2>/dev/null
        mkdir -p /etc/online-upgrade-pkgdb/opkg-info
        cp /usr/lib/opkg/info/luci-app-online-upgrade.* /etc/online-upgrade-pkgdb/opkg-info/ 2>/dev/null
    fi
    # 现场生成首启注册修复脚本（uci-defaults 执行后自动删除，保证一定存在）
    cat > /etc/uci-defaults/92-online-upgrade-register <<'EOF'
#!/bin/sh
# 干净升级后：插件文件已由备份归档恢复，此处补回包管理器注册信息
[ -d /etc/online-upgrade-pkgdb ] || exit 0
if command -v apk >/dev/null 2>&1; then
	if ! apk info -e luci-app-online-upgrade >/dev/null 2>&1 && [ -s /etc/online-upgrade-pkgdb/apk-installed ]; then
		cat /etc/online-upgrade-pkgdb/apk-installed >> /lib/apk/db/installed
		echo "" >> /lib/apk/db/installed
		logger -t "online-upgrade" "Restored apk package registration"
	fi
elif command -v opkg >/dev/null 2>&1; then
	if ! opkg status luci-app-online-upgrade 2>/dev/null | grep -q '^Status:.*installed'; then
		[ -s /etc/online-upgrade-pkgdb/opkg-status ] && {
			cat /etc/online-upgrade-pkgdb/opkg-status >> /usr/lib/opkg/status
			echo "" >> /usr/lib/opkg/status
		}
		mkdir -p /usr/lib/opkg/info
		cp /etc/online-upgrade-pkgdb/opkg-info/* /usr/lib/opkg/info/ 2>/dev/null
		logger -t "online-upgrade" "Restored opkg package registration"
	fi
fi
rm -rf /etc/online-upgrade-pkgdb
exit 0
EOF
    chmod +x /etc/uci-defaults/92-online-upgrade-register
    EXISTING_FILES="$EXISTING_FILES /etc/online-upgrade-pkgdb /etc/uci-defaults/92-online-upgrade-register"
    ( cd / && tar czf $BACKUP_TMP $EXISTING_FILES 2>/dev/null )
    if [ $? -ne 0 ] || [ ! -s "$BACKUP_TMP" ]; then
        echo "Error: plugin backup failed!"
        exit 1
    fi
    echo "  Backup created: $(tar tzf "$BACKUP_TMP" 2>/dev/null | wc -l) plugin files"
fi

# ---- Step 4: 执行 sysupgrade
echo ""
if [ "$KEEP_MODE" = "keep" ]; then
    echo "Step 4: Running sysupgrade (configuration will be restored automatically)..."
else
    echo "Step 4: Running sysupgrade (clean upgrade, plugin only)..."
fi
echo "sysupgrade" > /tmp/online-upgrade-status
sync
sleep 1

# ---- 保存包列表（用于升级后自动重装）----
echo "  Saving the installed package list..."
apk info 2>/dev/null > /root/.pkg-list.txt
sync

if [ "$KEEP_MODE" = "keep" ]; then
    echo "  Command: sysupgrade -f ${BACKUP_TMP} ${TMP_FIRMWARE}"
    /sbin/sysupgrade -f "$BACKUP_TMP" "$TMP_FIRMWARE"
else
    echo "  Command: sysupgrade -f ${BACKUP_TMP} ${TMP_FIRMWARE}"
    /sbin/sysupgrade -f "$BACKUP_TMP" "$TMP_FIRMWARE"
fi

# 如果 sysupgrade 失败（返回了），清除记录避免误判
echo "Error: sysupgrade execution failed!" >> /tmp/online-upgrade.log
uci -q delete online-upgrade.settings.last_upgrade_ts
uci -q delete online-upgrade.settings.last_upgrade_version
uci commit online-upgrade
exit 1
