# codex-use — Codex CLI Provider Switcher

Quickly switch Codex CLI between different API providers (DeepSeek, Zhipu, etc.).

## Supported Providers

| Provider | Description |
|----------|-------------|
| `deepseek` | DeepSeek API (OpenAI-compatible) |
| `zhipu` | Zhipu BigModel (智谱 GLM, OpenAI-compatible) |

## Quick Install

```bash
git clone https://github.com/WangHaowen99/codex-use.git ~/codex-use
# or from Gitee:
# git clone https://gitee.com/wanghaowen2/codex-use.git ~/codex-use
cd ~/codex-use
bash install.sh
```

**After install, edit your credentials file:**

```bash
vim ~/.codex-providers.env
# Fill in your API keys for the providers you use.
# Leave unused providers blank.
```

Then reload your shell:

```bash
source ~/.bashrc
codex-which
```

## Prerequisites

- Bash 4.0+
- Codex CLI (`codex` command)
- `paste` (from GNU coreutils)

## Usage

```bash
# List available providers
codex-providers

# Switch provider
codex-use deepseek
codex-use zhipu

# Show current provider info
codex-which
```

## How It Works

`codex-use` modifies Codex's configuration files:
- `~/.codex/config.toml` — updates `model_provider`, `model`, and provider sections
- `~/.codex/auth.json` — updates the API key

## Troubleshooting

**`codex-use deepseek` shows "credential is missing"**

Edit `~/.codex-providers.env` and set your API key:
```bash
CODEX_DEEPSEEK_API_KEY='sk-your-actual-key'
```

**`codex-which` shows "config not found"**

Make sure Codex CLI is installed and `CODEX_HOME` is set correctly.

**DeepSeek proxy (optional)**

If you use a local deepseek proxy (e.g. `http://127.0.0.1:8788/v1`), update the base URL in `~/.codex-providers.env`:
```bash
CODEX_DEEPSEEK_BASE_URL='http://127.0.0.1:8788/v1'
```

## Repositories

- GitHub: [WangHaowen99/codex-use](https://github.com/WangHaowen99/codex-use)
- Gitee: [wanghaowen2/codex-use](https://gitee.com/wanghaowen2/codex-use)

## License

MIT
