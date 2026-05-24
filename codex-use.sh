#!/usr/bin/env bash
# codex-use — Codex CLI provider switcher
# Usage: source codex-use.sh   (add to your ~/.bashrc)
#        codex-use <provider>
#        codex-which
#        codex-providers

# Guard: prevent double-sourcing
if [[ "${__CODEX_USE_LOADED:-}" = "1" ]]; then
    return 0
fi
__CODEX_USE_LOADED=1

# ── Config ──────────────────────────────────────────────────
__codex_home="${CODEX_HOME:-$HOME/codex-home}"
__codex_config="${__codex_home}/config.toml"
__codex_auth="${__codex_home}/auth.json"
__codex_provider_env="${CODEX_PROVIDER_ENV:-$HOME/.codex-providers.env}"

# ── Helpers ─────────────────────────────────────────────────

__codex_load_provider_env() {
    if [ -f "$__codex_provider_env" ]; then
        . "$__codex_provider_env"
    fi
}

__codex_toml_set() {
    local key="$1" value="$2" file="$__codex_config"
    if grep -q "^${key}\s*=" "$file" 2>/dev/null; then
        sed -i "s|^${key}\s*=.*|${key} = \"${value}\"|" "$file"
    else
        echo "${key} = \"${value}\"" >> "$file"
    fi
}

__codex_ensure_provider_section() {
    local name="$1" base_url="$2" wire_api="${3:-responses}"
    local file="$__codex_config"

    if grep -q "^\[model_providers\.${name}\]" "$file" 2>/dev/null; then
        # Update existing section
        sed -i "/^\[model_providers\.${name}\]/,/^\[/ {
            s|^base_url\s*=.*|base_url = \"${base_url}\"|
            s|^wire_api\s*=.*|wire_api = \"${wire_api}\"|
            /^requires_openai_auth\s*=/d
        }" "$file"
        # Re-add requires_openai_auth after wire_api
        sed -i "/^\[model_providers\.${name}\]/,/^\[/ {
            /^wire_api\s*=/a\\requires_openai_auth = true
        }" "$file"
    else
        # Add new section
        cat >> "$file" << PROVIDEREOF

[model_providers.${name}]
name = "${name}"
base_url = "${base_url}"
wire_api = "${wire_api}"
requires_openai_auth = true
PROVIDEREOF
    fi
}

__codex_write_auth() {
    local api_key="$1"
    local tmp
    tmp=$(mktemp)
    printf '{"OPENAI_API_KEY":"%s"}\n' "$api_key" > "$tmp"
    chmod 600 "$tmp"
    mv "$tmp" "$__codex_auth"
}

# ── Provider registry ───────────────────────────────────────

codex-providers() {
    printf '%s\n' deepseek zhipu
}

__codex_apply_provider() {
    local provider="$1"
    local base_url="" api_key="" model=""

    case "$provider" in
        deepseek)
            base_url="${CODEX_DEEPSEEK_BASE_URL:-}"
            api_key="${CODEX_DEEPSEEK_API_KEY:-}"
            model="${CODEX_DEEPSEEK_MODEL:-}"
            ;;
        zhipu)
            base_url="${CODEX_ZHIPU_BASE_URL:-}"
            api_key="${CODEX_ZHIPU_API_KEY:-}"
            model="${CODEX_ZHIPU_MODEL:-}"
            ;;
        *)
            printf 'codex-use: unknown provider: %s\n' "$provider" >&2
            printf 'Available providers:\n' >&2
            codex-providers >&2
            return 2
            ;;
    esac

    if [ -z "$api_key" ]; then
        printf 'codex-use: credential for %s is missing. Edit %s first.\n' "$provider" "$__codex_provider_env" >&2
        return 1
    fi

    # Ensure config directory exists
    mkdir -p "$__codex_home"

    # Ensure provider section in config.toml
    __codex_ensure_provider_section "$provider" "$base_url"

    # Set active provider and model
    __codex_toml_set "model_provider" "$provider"
    __codex_toml_set "model" "$model"

    # Write auth.json
    __codex_write_auth "$api_key"

    export CODEX_PROVIDER="$provider"
}

# ── Public commands ─────────────────────────────────────────

codex-which() {
    if [ ! -f "$__codex_config" ]; then
        printf 'codex config not found: %s\n' "$__codex_config" >&2
        return 1
    fi
    local provider model
    provider=$(grep '^model_provider\s*=' "$__codex_config" | head -1 | sed 's/.*=\s*"*\([^"]*\)"*/\1/' | tr -d ' ')
    model=$(grep '^model\s*=' "$__codex_config" | head -1 | sed 's/.*=\s*"*\([^"]*\)"*/\1/' | tr -d ' ')
    printf 'provider: %s\n' "${provider:-<unset>}"
    printf 'model:    %s\n' "${model:-<unset>}"
}

codex-use() {
    local provider="${1:-}"

    case "$provider" in
        ''|-h|--help)
            printf 'Usage: codex-use <%s>\n' "$(codex-providers | paste -sd '|' -)"
            printf '\nCurrent:\n'
            codex-which
            return 0
            ;;
    esac

    if ! codex-providers | grep -qx "$provider"; then
        printf 'codex-use: unknown provider: %s\n' "$provider" >&2
        printf 'Available providers:\n' >&2
        codex-providers >&2
        return 2
    fi

    __codex_load_provider_env
    __codex_apply_provider "$provider" || return $?

    printf 'Codex provider switched to %s (model: %s)\n' "$provider" "$(grep '^model\s*=' "$__codex_config" | head -1 | sed 's/.*=\s*"*\([^"]*\)"*/\1/' | tr -d ' ')"
    codex-which
}

# ── Auto-load on source ─────────────────────────────────────
__codex_load_provider_env
