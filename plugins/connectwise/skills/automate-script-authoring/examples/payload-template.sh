#!/bin/sh
# TEMPLATE - <Product> deploy payload for ConnectWise Automate on macOS.
# Delivered with File Write Text into a root-only folder, then run by Shell
# Command, so the secret never appears on a command line. Runs as root.
# Last line is always PRODUCT_RESULT=<code> <message>; always exits 0.
# Replace every TODO. ASCII only.

T='@secretvar@'   # TODO: rename. Single quotes are deliberate; Automate rejects ' first.

main() {
    PREFIX="PRODUCT"                                         # TODO
    PKGID="com.vendor.agent"                                 # TODO: pkg receipt id
    TEAM="ABCDE12345"                                        # TODO: vendor signing team
    URL="https://vendor.example/agent/macos/ARCH/agent.pkg"  # TODO: ARCH is replaced below
    LOCK="/private/var/run/yourorg-product.lock"             # TODO
    DIT="/Library/Application Support/YourOrg"               # TODO
    RESULT="$DIT/product-result"
    U="$(printf '\100')secretvar$(printf '\100')"            # TODO: match the variable name
    D=""; HAVE_LOCK=0

    [ "$(id -u)" -eq 0 ] || r FAIL_PRIVILEGE "not root"

    if ! mkdir "$LOCK" 2>/dev/null; then
        if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +120 2>/dev/null)" ] && rmdir "$LOCK" 2>/dev/null && mkdir "$LOCK" 2>/dev/null; then
            echo "cleared a stale lock"
        else
            r WARN_BUSY "another run is active, took no action"
        fi
    fi
    HAVE_LOCK=1
    trap 'r FAIL_INTERRUPTED "run was killed by a signal"' HUP INT TERM
    rm -f "$RESULT"

    case "$T" in ""|"$U") r FAIL_TOKEN "secret empty or not substituted" ;; esac
    printf '%s' "$T" | grep -Eq '^[0-9a-fA-F]{32,128}$' || r FAIL_TOKEN "secret malformed"   # TODO: real format

    V="$(pkgutil --pkg-info "$PKGID" 2>/dev/null | awk '/^version: /{print $2; exit}')"
    [ -n "$V" ] && r OK_ENROLLED "already installed ($V)"                 # TODO: registration state

    if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ]; then A=arm64
    elif [ "$(uname -m)" = "x86_64" ]; then A=x86_64
    else r FAIL_ARCH "unsupported architecture"; fi

    D="$(mktemp -d /private/tmp/yo.XXXXXX)" || r FAIL_INSTALL "mktemp failed"
    chmod 700 "$D"
    curl -fsSL --connect-timeout 30 --max-time 600 "$(printf '%s' "$URL" | sed "s/ARCH/$A/")" -o "$D/a.pkg" \
        || r FAIL_DOWNLOAD "download failed"
    [ "$(wc -c < "$D/a.pkg" | tr -d ' ')" -ge 1048576 ] || r FAIL_DOWNLOAD "download too small"
    [ "$(head -c 4 "$D/a.pkg")" = "xar!" ] || r FAIL_DOWNLOAD "not a flat pkg"

    SIG="$(pkgutil --check-signature "$D/a.pkg" 2>&1)"
    STATUS="$(printf '%s\n' "$SIG" | sed -n 's/^[[:space:]]*Status: //p' | head -1)"
    case "$STATUS" in
        "signed by a developer certificate issued by Apple"*)
            printf '%s\n' "$SIG" | grep -q "($TEAM)" || r FAIL_DOWNLOAD "signed, but not by team $TEAM" ;;
        "no signature") r FAIL_DOWNLOAD "pkg unsigned" ;;          # TODO: tolerate only if the vendor ships unsigned
        "") r FAIL_DOWNLOAD "pkgutil could not check the signature" ;;
        *) r FAIL_DOWNLOAD "signature status '$STATUS'" ;;
    esac

    # TODO: hand the secret to the installer (chmod 600 file it reads), never argv
    installer -pkg "$D/a.pkg" -target / > "$D/l" 2>&1 || r FAIL_INSTALL "installer failed"

    N="$(pkgutil --pkg-info "$PKGID" 2>/dev/null | awk '/^version: /{print $2; exit}')"
    [ -n "$N" ] || r FAIL_VERIFY "no receipt for $PKGID"
    r OK_INSTALLED "installed $N"
}

r() {
    trap - HUP INT TERM
    if [ "$1" != WARN_BUSY ]; then
        if mkdir -p "$DIT" 2>/dev/null && chmod 700 "$DIT" 2>/dev/null; then
            printf '%s' "$1" > "$RESULT" 2>/dev/null || echo "could not write $RESULT, Automate will record NO_RESULT"
        else
            echo "could not create $DIT, Automate will record NO_RESULT"
        fi
        [ -n "$D" ] && rm -rf "$D"
        [ "$HAVE_LOCK" = 1 ] && rmdir "$LOCK" 2>/dev/null
    fi
    echo "${PREFIX}_RESULT=$1 $2"
    exit 0
}

main "$@"
