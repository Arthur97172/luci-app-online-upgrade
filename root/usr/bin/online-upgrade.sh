
#!/bin/sh
# =====================================================
# Online Upgrade Script for ImmortalWrt/OpenWrt
# Part of luci-app-online-upgrade
#
# Supports:
#   - Existing combined-efi.*.img.gz firmware
#   - Configured firmware_pattern
#   - Generic sysupgrade .itb firmware
#
# IMPORTANT:
#   Test on the target device before using upgrade mode.
# =====================================================

CONFIG_FILE="/etc/config/online-upgrade"

# ---- Read UCI config ----
get_uci() {
    uci -q get "online-upgrade.settings.$1" 2>/dev/null
}

REPO="$(get_uci repo)"
TAG="$(get_uci tag)"
PROXY="$(get_uci proxy)"
FW_PATTERN="$(get_uci firmware_pattern)"
KEEP_CONFIG="$(get_uci keep_config)"

[ -z "$REPO" ] && REPO="gooyjq/ImmortalWrt-Builder"
[ -z "$TAG" ] && TAG="Autobuild-x86-64"
[ -z "$PROXY" ] && PROXY="https://ghfast.top/"
[ -z "$FW_PATTERN" ] && FW_PATTERN="combined-efi.*\\.img\\.gz"

API_URL="https://api.github.com/repos/${REPO}/releases/tags/${TAG}"
TMP_JSON="/tmp/release.json"

MODE="${1:-check}"
STATUS_FILE="/tmp/online-upgrade-status"
LOG_FILE="/tmp/online-upgrade.log"

# ---- Utility functions ----

set_status() {
    echo "$1" > "$STATUS_FILE"
}

utc_to_local() {
    utc_str="$1"
    clean="$(echo "$utc_str" | sed 's/T/ /; s/Z//')"
    epoch="$(date -d "$clean" +%s 2>/dev/null)"

    if [ -z "$epoch" ] || [ "$epoch" = "0" ]; then
        echo "$utc_str"
        return
    fi

    # Keep original script's UTC+8 display behavior.
    epoch=$((epoch + 8 * 3600))
    date -d "@${epoch}" +"%Y-%m-%d %H:%M:%S" 2>/dev/null \
        || echo "$utc_str"
}

extract_fw_version() {
    filename="$1"
    fwver="$(echo "$filename" |
        grep -oE '[0-9]+\.[0-9]+\.[0-9]+' |
        head -n 1)"

    echo "${fwver:-0}"
}

ver_to_num() {
    echo "$1" |
        awk -F. '{printf "%d%02d%02d", $1, $2, $3}' 2>/dev/null
}

is_newer_version() {
    cur_num="$(ver_to_num "$1")"
    new_num="$(ver_to_num "$2")"

    [ -n "$cur_num" ] && [ -n "$new_num" ] &&
        [ "$cur_num" -lt "$new_num" ] 2>/dev/null
}

fail() {
    message="$1"
    status="${2:-failed:$1}"

    echo "$status" > "$STATUS_FILE"
    echo "错误：$message"
    exit 1
}

cleanup_release_json() {
    rm -f "$TMP_JSON"
}

# ---- Background mode ----
if [ "$MODE" = "background" ] ||
   [ "$MODE" = "--background" ] ||
   [ "$MODE" = "--bg" ]; then
    setsid /bin/sh "$0" upgrade \
        </dev/null >/tmp/online-upgrade.log 2>&1 &
    exit 0
fi

# ---- Reset mode ----
if [ "$MODE" = "reset" ] || [ "$MODE" = "--reset" ]; then
    uci -q delete online-upgrade.settings.last_upgrade_ts
    uci -q delete online-upgrade.settings.last_upgrade_version
    uci commit online-upgrade
    echo "更新记录已重置。"
    exit 0
fi

# ---- Backup-only mode ----
if [ "$MODE" = "backup" ] || [ "$MODE" = "--backup" ]; then
    TS="$(date +%Y%m%d-%H%M%S)"
    BAK="/tmp/pre-upgrade-backup-${TS}.tar.gz"
    BAK_ROOT="/root/pre-upgrade-backup-${TS}.tar.gz"

    echo "正在创建配置备份..."
    sysupgrade -b "$BAK"

    if [ $? -eq 0 ] && [ -s "$BAK" ]; then
        cp "$BAK" "$BAK_ROOT" || {
            echo "错误：无法保存备份到 /root！"
            exit 1
        }

        echo "备份成功: $BAK_ROOT ($(du -h "$BAK" | cut -f1))"
        echo "备份中包含 $(tar tzf "$BAK" 2>/dev/null | wc -l) 个文件"
        echo "提示：升级时可使用 -f 参数恢复配置。"
    else
        echo "错误：备份失败！"
        exit 1
    fi

    exit 0
fi

echo "========================================"
echo "  固件在线升级"
echo "  仓库: ${REPO}  |  标签: ${TAG}"
echo "========================================"

# =====================================================
# Step 1: Get GitHub Release information
# =====================================================

echo ""
echo "[1/2] 正在获取 Release 信息..."

GITHUB_TOKEN="$(get_uci github_token)"

if [ -n "$GITHUB_TOKEN" ]; then
    HTTP_CODE="$(curl -sL \
        -H "Authorization: Bearer $GITHUB_TOKEN" \
        -H "User-Agent: curl/online-upgrade" \
        -o "$TMP_JSON" \
        -w "%{http_code}" \
        "$API_URL")"
else
    HTTP_CODE="$(curl -sL \
        -H "User-Agent: curl/online-upgrade" \
        -o "$TMP_JSON" \
        -w "%{http_code}" \
        "$API_URL")"
fi

# Try proxy only if direct connection failed.
if [ "$HTTP_CODE" = "000" ]; then
    echo "警告：直连 GitHub API 失败，尝试通过代理..."
    PROXY_API="${PROXY}${API_URL}"

    if [ -n "$GITHUB_TOKEN" ]; then
        HTTP_CODE="$(curl -sL \
            -H "Authorization: Bearer $GITHUB_TOKEN" \
            -H "User-Agent: curl/online-upgrade" \
            -o "$TMP_JSON" \
            -w "%{http_code}" \
            "$PROXY_API")"
    else
        HTTP_CODE="$(curl -sL \
            -H "User-Agent: curl/online-upgrade" \
            -o "$TMP_JSON" \
            -w "%{http_code}" \
            "$PROXY_API")"
    fi
fi

# Retry GitHub API rate limit.
if [ "$HTTP_CODE" = "403" ]; then
    echo "警告：GitHub API 限速，等待后重试..."

    for r in 1 2 3; do
        sleep $((r * 15))
        echo "  第${r}次重试..."

        if [ -n "$GITHUB_TOKEN" ]; then
            HTTP_CODE="$(curl -sL \
                -H "Authorization: Bearer $GITHUB_TOKEN" \
                -H "User-Agent: curl/online-upgrade" \
                -o "$TMP_JSON" \
                -w "%{http_code}" \
                "$API_URL")"
        else
            HTTP_CODE="$(curl -sL \
                -H "User-Agent: curl/online-upgrade" \
                -o "$TMP_JSON" \
                -w "%{http_code}" \
                "$API_URL")"
        fi

        [ "$HTTP_CODE" = "200" ] && break
    done
fi

if [ "$HTTP_CODE" = "403" ]; then
    echo "错误：GitHub API 返回 HTTP 403（可能触发限速）"
    echo "可配置 github_token 提高 API 限额。"
    cleanup_release_json
    exit 1
elif [ "$HTTP_CODE" != "200" ]; then
    echo "错误：GitHub API 返回 HTTP $HTTP_CODE"
    cleanup_release_json
    exit 1
fi

if [ ! -s "$TMP_JSON" ]; then
    fail "Release JSON 为空"
fi

# =====================================================
# Step 2: Find firmware asset
# =====================================================

echo ""
echo "[2/2] 正在查找最新固件..."

FILE_NAMES="$(jsonfilter -i "$TMP_JSON" -e '@.assets[*].name' 2>/dev/null)"

if [ -z "$FILE_NAMES" ]; then
    cleanup_release_json
    fail "Release 中没有可读取的 assets"
fi

FILE_NAME=""

# 1. User-configured pattern has highest priority.
if [ -n "$FW_PATTERN" ]; then
    FILE_NAME="$(printf '%s\n' "$FILE_NAMES" |
        grep -E "$FW_PATTERN" |
        head -n 1)"
fi

# 2. Preserve existing combined image fallback.
if [ -z "$FILE_NAME" ]; then
    FILE_NAME="$(printf '%s\n' "$FILE_NAMES" |
        grep -E 'combined.*\.img\.gz$' |
        head -n 1)"
fi

# 3. Prefer sysupgrade .itb images.
if [ -z "$FILE_NAME" ]; then
    ITB_SYSUPGRADE="$(printf '%s\n' "$FILE_NAMES" |
        grep -E 'sysupgrade.*\.itb$')"

    ITB_SYSUPGRADE_COUNT="$(printf '%s\n' "$ITB_SYSUPGRADE" |
        grep -c .)"

    if [ "$ITB_SYSUPGRADE_COUNT" -eq 1 ]; then
        FILE_NAME="$ITB_SYSUPGRADE"
    elif [ "$ITB_SYSUPGRADE_COUNT" -gt 1 ]; then
        echo "错误：发现多个 sysupgrade .itb 固件："
        printf '%s\n' "$ITB_SYSUPGRADE"
        echo "请通过 firmware_pattern 指定目标固件。"
        cleanup_release_json
        exit 1
    fi
fi

# 4. If no sysupgrade-named .itb exists, accept a single .itb.
#    Multiple candidates must be explicitly selected by the user.
if [ -z "$FILE_NAME" ]; then
    ITB_FILES="$(printf '%s\n' "$FILE_NAMES" |
        grep -E '\.itb$')"

    ITB_COUNT="$(printf '%s\n' "$ITB_FILES" | grep -c .)"

    if [ "$ITB_COUNT" -eq 1 ]; then
        FILE_NAME="$ITB_FILES"
    elif [ "$ITB_COUNT" -gt 1 ]; then
        echo "错误：发现多个 .itb 文件，无法自动确定目标："
        printf '%s\n' "$ITB_FILES"
        echo "请通过 firmware_pattern 指定目标固件。"
        cleanup_release_json
        exit 1
    fi
fi

if [ -z "$FILE_NAME" ]; then
    cleanup_release_json
    fail "未找到匹配的固件文件"
fi

echo "  找到固件: $FILE_NAME"

# IMPORTANT: FILE_NAME is now known.
# Use the actual asset name as the local filename.
TMP_FIRMWARE="/tmp/${FILE_NAME}"

ASSET_UPDATED="$(jsonfilter -i "$TMP_JSON" \
    -e "@.assets[@.name=\"${FILE_NAME}\"].updated_at" 2>/dev/null)"

ASSET_SIZE="$(jsonfilter -i "$TMP_JSON" \
    -e "@.assets[@.name=\"${FILE_NAME}\"].size" 2>/dev/null)"

DOWNLOAD_URL="$(jsonfilter -i "$TMP_JSON" \
    -e "@.assets[@.name=\"${FILE_NAME}\"].browser_download_url" 2>/dev/null)"

ASSET_UPDATED_LOCAL="$(utc_to_local "$ASSET_UPDATED")"
FW_VERSION_RELEASE="$(extract_fw_version "$FILE_NAME")"

cleanup_release_json

if [ -z "$DOWNLOAD_URL" ]; then
    fail "无法获取固件下载地址"
fi

if [ -z "$ASSET_UPDATED" ]; then
    fail "Release 固件缺少 updated_at 时间戳"
fi

# =====================================================
# Current firmware and update comparison
# =====================================================

CURRENT_RELEASE="$(grep '^DISTRIB_RELEASE=' /etc/openwrt_release 2>/dev/null |
    cut -d"'" -f2)"

CURRENT_REVISION="$(grep '^DISTRIB_REVISION=' /etc/openwrt_release 2>/dev/null |
    cut -d"'" -f2 | sed 's/^r//')"

CURRENT_ID="$(grep '^DISTRIB_ID=' /etc/openwrt_release 2>/dev/null |
    cut -d"'" -f2)"

LAST_TS="$(get_uci last_upgrade_ts)"
LAST_VERSION="$(get_uci last_upgrade_version)"

NEW_FIRMWARE=0
UPDATE_REASON=""

if [ -z "$LAST_TS" ] && [ -z "$LAST_VERSION" ]; then
    NEW_FIRMWARE=1
    UPDATE_REASON="首次检测"

elif [ "$FW_VERSION_RELEASE" != "0" ] &&
     [ "$CURRENT_RELEASE" != "$FW_VERSION_RELEASE" ]; then

    if is_newer_version "$CURRENT_RELEASE" "$FW_VERSION_RELEASE"; then
        NEW_FIRMWARE=1
        UPDATE_REASON="新版固件 v${FW_VERSION_RELEASE}（当前 v${CURRENT_RELEASE}）"

    elif [ -n "$LAST_VERSION" ] &&
         [ "$LAST_VERSION" != "$FW_VERSION_RELEASE" ]; then
        NEW_FIRMWARE=1
        UPDATE_REASON="固件重新编译（v${FW_VERSION_RELEASE}）"

    else
        UPDATE_REASON="已是最新（v${CURRENT_RELEASE}）"
    fi

elif [ "$ASSET_UPDATED" != "$LAST_TS" ]; then
    NEW_FIRMWARE=1
    UPDATE_REASON="固件重新编译（${ASSET_UPDATED_LOCAL}）"

else
    UPDATE_REASON="已是最新"
fi

# =====================================================
# Display firmware information
# =====================================================

echo ""
echo "============================================"
echo "  固件状态"
echo "============================================"
echo "  当前固件: ${CURRENT_ID} ${CURRENT_RELEASE} (r${CURRENT_REVISION})"
echo "  新固件版本: v${FW_VERSION_RELEASE:-N/A}"
echo "  最新固件: ${FILE_NAME}"
echo "  文件大小: $(printf "%.0f MB" $((${ASSET_SIZE:-0} / 1024 / 1024)) 2>/dev/null)"
echo "  编译时间: ${ASSET_UPDATED_LOCAL}"
echo "  检测依据: ${UPDATE_REASON}"
echo "============================================"

[ "$NEW_FIRMWARE" = "1" ] &&
    echo "" &&
    echo "  >>> 发现新固件！"

# Check mode exits without downloading or upgrading.
if [ "$MODE" != "upgrade" ] && [ "$MODE" != "--upgrade" ]; then
    echo ""
    echo "  升级: online-upgrade.sh upgrade"
    exit 0
fi

# =====================================================
# Upgrade execution
# =====================================================

echo ""
echo "============================================"
echo "  [执行升级]"
echo "============================================"

FULL_URL="${PROXY}${DOWNLOAD_URL}"

# ---- Step 1: Download or reuse cached firmware ----

echo ""
echo "Step 1: 下载固件..."

DOWNLOAD_SKIP=0

if [ -f "$TMP_FIRMWARE" ] &&
   [ -s "$TMP_FIRMWARE" ] &&
   [ -f "${TMP_FIRMWARE}.ts" ]; then

    LOCAL_TS="$(cat "${TMP_FIRMWARE}.ts" 2>/dev/null)"

    if [ "$LOCAL_TS" = "$ASSET_UPDATED" ]; then
        echo "  固件已下载，跳过（${ASSET_UPDATED_LOCAL}）"
        DOWNLOAD_SKIP=1
    fi
fi

if [ "$DOWNLOAD_SKIP" = "0" ]; then
    set_status "downloading"

    echo "  URL: $(echo "$FULL_URL" | head -c 100)..."

    rm -f "$TMP_FIRMWARE" "${TMP_FIRMWARE}.ts"

    if ! curl -fLsS -o "$TMP_FIRMWARE" "$FULL_URL"; then
        rm -f "$TMP_FIRMWARE" "${TMP_FIRMWARE}.ts"
        fail "下载失败"
    fi

    if [ ! -s "$TMP_FIRMWARE" ]; then
        rm -f "$TMP_FIRMWARE" "${TMP_FIRMWARE}.ts"
        fail "下载的固件文件为空"
    fi

    echo "  下载成功 ($(du -h "$TMP_FIRMWARE" | cut -f1))"
fi

# =====================================================
# Step 1.5: Validate firmware BEFORE recording or backup
# =====================================================

echo ""
echo "Step 1.5: 检查固件..."

if [ ! -s "$TMP_FIRMWARE" ]; then
    fail "固件文件不存在或为空"
fi

# Do not flash based on extension alone.
# Let the device's sysupgrade implementation perform its test.
if ! /sbin/sysupgrade -T "$TMP_FIRMWARE"; then
    rm -f "${TMP_FIRMWARE}.ts"
    fail "固件未通过 sysupgrade 测试，取消升级"
fi

echo "  sysupgrade 镜像测试通过"

# Cache timestamp only after successful image test.
echo "$ASSET_UPDATED" > "${TMP_FIRMWARE}.ts"

# =====================================================
# Step 2: Record version information
# =====================================================

echo ""
echo "Step 2: 记录固件版本..."

set_status "saving_ts"

uci set online-upgrade.settings.last_upgrade_ts="$ASSET_UPDATED"
uci set online-upgrade.settings.last_upgrade_version="${FW_VERSION_RELEASE:-0}"

if ! uci commit online-upgrade; then
    fail "无法保存升级版本记录"
fi

sync

echo "  已记录版本: v${FW_VERSION_RELEASE:-N/A} (${ASSET_UPDATED_LOCAL})"

# =====================================================
# Step 3: Create sysupgrade backup
# =====================================================

TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_TMP="/tmp/pre-upgrade-backup-${TS}.tar.gz"
BACKUP_ROOT="/root/pre-upgrade-backup-${TS}.tar.gz"

echo ""
echo "Step 3: 创建 sysupgrade 配置备份..."

if ! sysupgrade -b "$BACKUP_TMP"; then
    fail "配置备份命令执行失败"
fi

if [ ! -s "$BACKUP_TMP" ]; then
    fail "配置备份文件为空"
fi

if ! cp "$BACKUP_TMP" "$BACKUP_ROOT"; then
    fail "无法保存应急备份到 /root"
fi

echo "  备份成功: ${BACKUP_ROOT} ($(du -h "$BACKUP_TMP" | cut -f1))"
echo "  备份中包含 $(tar tzf "$BACKUP_TMP" 2>/dev/null | wc -l) 个文件"

# =====================================================
# Step 4: Execute sysupgrade
# =====================================================

echo ""
echo "Step 4: 执行 sysupgrade..."

set_status "sysupgrade"
sync
sleep 1

# Save installed package list for possible post-upgrade recovery.
echo "  正在保存已安装包列表..."
apk info 2>/dev/null > /root/.pkg-list.txt
sync

echo "  命令: sysupgrade -f ${BACKUP_TMP} ${TMP_FIRMWARE}"

# Keep the original script's configuration restore behavior.
# KEEP_CONFIG is read from UCI but was not used by the original
# upgrade command; this preserves that behavior.
#
# sysupgrade normally does not return when upgrade succeeds.
# If it returns, treat it as a failure.
if /sbin/sysupgrade -f "$BACKUP_TMP" "$TMP_FIRMWARE"; then
    :
fi

# If sysupgrade returns, clear the potentially misleading record.
echo "错误：sysupgrade 执行失败或异常返回！" >> "$LOG_FILE"

uci -q delete online-upgrade.settings.last_upgrade_ts
uci -q delete online-upgrade.settings.last_upgrade_version
uci commit online-upgrade

set_status "failed:sysupgrade 执行失败或异常返回"
exit 1
