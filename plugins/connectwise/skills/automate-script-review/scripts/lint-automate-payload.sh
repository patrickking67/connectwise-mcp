#!/bin/bash
# Static checks for a ConnectWise Automate script payload (PowerShell or sh).
#
# Usage: lint-automate-payload.sh [--marker TEXT] <file> [file...]
#   --marker TEXT   result marker that must appear in code (default: _RESULT=)
#
# Prints one finding per line:  LEVEL<TAB>file:line<TAB>rule<TAB>message
# LEVEL is ERROR, WARN or INFO. Exit status: 1 if any ERROR, else 0.
# Runs shellcheck / PSScriptAnalyzer as well when they are installed.
# Bash 3.2 compatible (stock macOS).

MARKER="_RESULT="
files=()
while [ $# -gt 0 ]; do
    case "$1" in
        --marker) [ $# -ge 2 ] || { echo "--marker needs a value" >&2; exit 2; }; MARKER="$2"; shift 2 ;;
        -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
        *) files+=("$1"); shift ;;
    esac
done
[ ${#files[@]} -gt 0 ] || { echo "usage: $0 [--marker TEXT] <file>..." >&2; exit 2; }

# Parse check plus PSScriptAnalyzer; the path arrives in $env:LINT_PATH.
# shellcheck disable=SC2016  # PowerShell code, expanded by pwsh not bash
PS_LINT='
$p = $env:LINT_PATH; $e = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$null, [ref]$e)
foreach ($x in $e) { "ParseError`t$($x.Extent.StartLineNumber)`tparse`t$($x.Message)" }
if (Get-Module -ListAvailable PSScriptAnalyzer) {
    Invoke-ScriptAnalyzer -Path $p -Severity Warning, Error | ForEach-Object { "$($_.Severity)`t$($_.Line)`t$($_.RuleName)`t$($_.Message -replace "\s+", " ")" }
} else { "Information`t0`tpsscriptanalyzer`tPSScriptAnalyzer not installed; skipped" }
'

errors=0
emit() {  # level file line rule message
    printf '%s\t%s:%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$5"
    [ "$1" = ERROR ] && errors=$((errors + 1))
}

# Emit one finding per line of the code view ($CODE: comments blanked, line
# numbers kept) that matches ERE and does not match the optional exclude-ERE.
each() {  # level rule message file ERE [exclude-ERE]
    local level="$1" rule="$2" msg="$3" f="$4" re="$5" ex="$6" ln text
    while IFS= read -r line; do
        ln="${line%%:*}"; text="${line#*:}"
        if [ -n "$ex" ] && printf '%s\n' "$text" | grep -qE -- "$ex"; then continue; fi
        emit "$level" "$f" "$ln" "$rule" "$msg"
    done < <(grep -nE -- "$re" "$CODE")
}

# Copy of the file with comments replaced by blank lines, so rules see code
# only. PowerShell: # lines and <# #> blocks. sh: # lines (not the shebang).
code_view() {  # file kind -> path of the code view
    local out; out="$(mktemp "${TMPDIR:-/tmp}/lintcode.XXXXXX")"
    if [ "$2" = ps ]; then
        awk '{ l=$0
               if (inblk) { if (l ~ /#>/) inblk=0; print ""; next }
               if (l ~ /^[ \t]*<#/) { if (l !~ /#>/) inblk=1; print ""; next }
               if (l ~ /^[ \t]*#/) { print ""; next }
               print l }' "$1" > "$out"
    else
        awk 'NR > 1 && /^[ \t]*#/ { print ""; next } { print }' "$1" > "$out"
    fi
    echo "$out"
}

kind_of() {
    case "$1" in
        *.ps1|*.psm1) echo ps ;;
        *.sh|*.bash|*.zsh) echo sh ;;
        *) head -1 "$1" | grep -qE '^#!.*(sh|bash|zsh)' && echo sh || echo ps ;;
    esac
}

for f in "${files[@]}"; do
    [ -r "$f" ] || { emit ERROR "$f" 0 unreadable "cannot read file"; continue; }
    kind="$(kind_of "$f")"
    CODE="$(code_view "$f" "$kind")"

    # -- Automate substitution -------------------------------------------------
    # @var@ values come from EDFs and script variables that people type into.
    # Inside double quotes the shell expands $( ) and backticks in them, as
    # SYSTEM or root, before the payload's own validation runs.
    each ERROR token-double-quoted \
        "@variable@ inside double quotes; Automate pastes the raw value in, so \$( ) in it executes. Use single quotes and reject ' in the Automate script." \
        "$f" '"[^"]*@[A-Za-z_][A-Za-z0-9_]*@[^"]*"'
    # Every substitution site, for the reviewer's inventory.
    while IFS=: read -r ln rest; do
        toks="$(printf '%s' "$rest" | grep -oE '@[A-Za-z_][A-Za-z0-9_]*@|%[A-Za-z_][A-Za-z0-9_]*%' | sort -u | tr '\n' ' ')"
        emit INFO "$f" "$ln" substitution "Automate will substitute: ${toks% }"
    done < <(grep -nE '@[A-Za-z_][A-Za-z0-9_]*@|%[A-Za-z_][A-Za-z0-9_]*%' "$f")

    # -- Encoding --------------------------------------------------------------
    while IFS=: read -r ln _; do
        emit WARN "$f" "$ln" non-ascii "non-ASCII character; the Automate script editor and agent can mangle it"
    done < <(LC_ALL=C grep -nE '[^ -~	]' "$f")
    if [ "$(head -c 3 "$f" | od -An -tx1 | tr -d ' ')" = efbbbf ]; then
        emit WARN "$f" 1 bom "UTF-8 byte-order mark; strip it before pasting into Automate"
    fi
    if LC_ALL=C grep -q $'\r' "$f"; then
        emit WARN "$f" 1 crlf "CRLF line endings; a Mac payload written with CRLF fails under /bin/sh"
    fi
    # File Write Text's Data field holds at most 32,767 characters.
    size=$(LC_ALL=C wc -m < "$f" | tr -d ' ')
    if [ "$size" -gt 32767 ]; then
        emit ERROR "$f" 1 size "$size characters; File Write Text holds at most 32,767 (keep Execute Script bodies under it too)"
    elif [ "$size" -gt 30000 ]; then
        emit WARN "$f" 1 size "$size characters; only $((32767 - size)) below the 32,767 File Write Text limit"
    fi

    # -- Result contract -------------------------------------------------------
    if ! grep -qF -- "$MARKER" "$CODE"; then
        emit ERROR "$f" 0 result-marker "no '$MARKER' line; Automate cannot tell outcomes apart without a result marker"
    fi

    # -- Platform pitfalls -----------------------------------------------------
    if [ "$kind" = ps ]; then
        each WARN start-process-wait \
            "Start-Process -Wait in PS 5.1 also waits for every descendant (msiexec's helpers can hang it); use Process.WaitForExit()" \
            "$f" 'Start-Process.*-Wait'
        each WARN iwr-basic-parsing \
            "Invoke-WebRequest without -UseBasicParsing needs the IE engine, which SYSTEM may not have on 5.1" \
            "$f" 'Invoke-WebRequest' 'UseBasicParsing'
        each WARN msi-verbose-log \
            "/L*v writes every property, including secrets, to the log; use /L* with MsiHiddenProperties" \
            "$f" '/L\*v'
            # shellcheck disable=SC2016  # literal $env: in the pattern
        each WARN predictable-temp \
            "fixed file name in a shared temp folder; a standard user can plant or swap it before SYSTEM runs it. Use a private, randomly named folder" \
            "$f" '(Windows\\Temp|\$env:TEMP|\$env:TMP)\\[A-Za-z0-9_.-]+\.(msi|exe|ps1)'
        # shellcheck disable=SC2016  # literal $env: in the pattern
        each WARN predictable-temp \
            "fixed file name joined onto shared temp; use a private, randomly named folder" \
            "$f" "Join-Path[[:space:]]+\\\$env:(TEMP|TMP)[[:space:]]+['\"][^'\"]+\\.(msi|exe|ps1)"
        each INFO here-string "expandable here-string; check by hand that no @variable@ sits inside it" "$f" '@"[[:space:]]*$'
        each INFO silent-catch "empty catch block; make sure a failure here cannot read as success" "$f" 'catch[[:space:]]*\{[[:space:]]*\}'
        if ! grep -qE 'SilentlyContinue|ProgressPreference' "$f" && grep -q 'Invoke-WebRequest' "$f"; then
            emit INFO "$f" 0 progress-preference "set \$ProgressPreference = 'SilentlyContinue'; the progress bar slows downloads badly under SYSTEM"
        fi
    else
        each WARN plutil-raw "plutil -extract ... raw needs macOS 12+; on 11 it returns nothing. Use pkgutil --pkg-info or defaults read" "$f" 'plutil.*raw'
        if grep -qE 'uname[[:space:]]+-m' "$f" && ! grep -q 'hw.optional.arm64' "$f"; then
            each WARN uname-arch "uname -m reports x86_64 on Apple Silicon under Rosetta; check sysctl -n hw.optional.arm64 first" "$f" 'uname[[:space:]]+-m'
        fi
        each WARN curl-no-fail "curl without -f saves an HTTP error page as if it were the download" "$f" '(^|[;&|[:space:]])curl[[:space:]]' '-[A-Za-z]*f|--fail'
        each INFO bashism "[[ ]] is not POSIX; Automate runs Shell steps under /bin/sh" "$f" '(^|[[:space:]])\[\[[[:space:]]'
        if ! grep -qE '^[[:space:]]*trap[[:space:]]' "$f"; then
            emit INFO "$f" 0 no-trap "no trap; a killed run leaves no result and may leave its lock behind"
        fi
    fi

    # -- External linters ------------------------------------------------------
    if [ "$kind" = sh ] && command -v shellcheck >/dev/null 2>&1; then
        while IFS=: read -r _ ln _ lvl msg; do
            lvl="$(printf '%s' "$lvl" | tr -d ' ')"
            case "$lvl" in error) L=ERROR ;; warning) L=WARN ;; *) L=INFO ;; esac
            emit "$L" "$f" "$ln" shellcheck "${msg# }"
        done < <(shellcheck -s sh -f gcc "$f" 2>/dev/null)
    fi
    if [ "$kind" = ps ] && command -v pwsh >/dev/null 2>&1; then
        while IFS=$'\t' read -r sev ln rule msg; do
            [ -z "$sev" ] && continue
            case "$sev" in Error|ParseError) L=ERROR ;; Warning) L=WARN ;; *) L=INFO ;; esac
            emit "$L" "$f" "$ln" "$rule" "$msg"
        done < <(LINT_PATH="$f" pwsh -NoProfile -Command "$PS_LINT" 2>/dev/null)
    fi
    rm -f "$CODE"
done

[ $errors -eq 0 ]
