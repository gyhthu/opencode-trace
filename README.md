# opencode-trace

`opencode-trace` is a local OpenAI-compatible proxy for capturing full OpenCode model-call traces.

It is designed for building agentic training data from OpenCode runs. It records the exact model API payloads that pass through the proxy:

- system prompt and all request `messages`
- tool schemas in request `tools`
- `tool_choice` and model parameters
- assistant `tool_calls`
- tool-result context in later requests
- final assistant `content`
- DeepSeek-style `reasoning_content`
- raw streamed SSE events

The core idea:

```text
OpenCode -> http://127.0.0.1:5010/v1/chat/completions
             opencode-trace records request/response JSON
             -> https://api.deepseek.com/v1/chat/completions
```

MLflow is not required. This repository writes local JSON files that can be exported as training samples.

## Linux Quickstart

### 1. Check paths

```sh
opencode debug paths
```

Find the `config` path. It is usually:

```text
~/.config/opencode
```

### 2. Install Node.js

Node.js 18+ is required because the proxy uses the built-in `fetch` API.

```sh
node --version
npm --version
```

On Ubuntu/Debian:

```sh
sudo apt update
sudo apt install -y nodejs npm
```

If your distribution ships an old Node.js, install a newer Node.js from your company's approved package source.

### 3. Install this repository locally

```sh
mkdir -p ~/.local/share
git clone https://github.com/gyhthu/opencode-trace.git ~/.local/share/opencode-trace
cd ~/.local/share/opencode-trace
npm install
chmod +x bin/opencode-trace
mkdir -p ~/.local/bin
ln -sf ~/.local/share/opencode-trace/bin/opencode-trace ~/.local/bin/opencode-trace
```

Make sure `~/.local/bin` is in your `PATH`:

```sh
echo "$PATH"
```

If not, add this to your shell rc file:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

### 4. Configure OpenCode to use the local proxy

Edit:

```sh
nano ~/.config/opencode/opencode.jsonc
```

For DeepSeek, set the provider `baseURL` to the local proxy:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "deepseek": {
      "options": {
        "baseURL": "http://127.0.0.1:5010/v1"
      },
      "models": {
        "deepseek-v4-pro": {
          "options": {
            "reasoningEffort": "low"
          }
        }
      }
    }
  }
}
```

If you already have `provider.deepseek`, do not replace the whole object. Add only:

```json
"options": {
  "baseURL": "http://127.0.0.1:5010/v1"
}
```

If you use another OpenAI-compatible provider, set that provider's `baseURL` to:

```text
http://127.0.0.1:5010/v1
```

Then set `UPSTREAM_BASE_URL` in the service to your real provider or internal gateway.

Examples:

```text
https://api.deepseek.com
https://api.openai.com
https://llm-gateway.company.com
```

### 5. Install the systemd user service

Copy the service:

```sh
mkdir -p ~/.config/systemd/user
cp ~/.local/share/opencode-trace/systemd/opencode-trace-proxy.service ~/.config/systemd/user/
```

Check your Node path:

```sh
which node
```

If it is not `/usr/bin/node`, edit:

```sh
nano ~/.config/systemd/user/opencode-trace-proxy.service
```

Change `ExecStart` to the correct Node path.

If your upstream is not DeepSeek, also edit:

```ini
Environment=UPSTREAM_BASE_URL=https://api.deepseek.com
```

### 6. Start the proxy

```sh
systemctl --user daemon-reload
systemctl --user enable --now opencode-trace-proxy
systemctl --user status opencode-trace-proxy
```

Verify:

```sh
curl http://127.0.0.1:5010/health
```

Expected output:

```json
{"ok":true,"upstream":"https://api.deepseek.com","log_dir":"/home/YOU/.local/share/opencode-trace/logs"}
```

### 7. Restart OpenCode

Close old OpenCode sessions and start OpenCode again so it reloads the provider config.

Run a task that calls tools, for example:

```text
Count how many .py files are in the current directory.
```

### 8. Inspect traces

```sh
opencode-trace list
opencode-trace latest request
opencode-trace latest messages
opencode-trace latest tools
opencode-trace latest output
opencode-trace latest transcript
opencode-trace latest sample
opencode-trace turn sample
opencode-trace dataset
```

The most useful command for training export is:

```sh
opencode-trace dataset
```

It exports all model calls for the latest user turn. Each call has this shape:

```json
{
  "file": "...",
  "started_at": "...",
  "completed_at": "...",
  "value": {
    "model": "deepseek-v4-pro",
    "params": {
      "stream": true,
      "temperature": 0.5,
      "max_tokens": 32000
    },
    "messages": [],
    "tools": [],
    "tool_choice": "auto",
    "assistant_output": {
      "role": "assistant",
      "reasoning_content": "...",
      "content": "...",
      "tool_calls": []
    },
    "raw_trace_file": "...",
    "started_at": "...",
    "completed_at": "..."
  }
}
```

## Commands

```sh
opencode-trace list              # recent raw model calls
opencode-trace latest request    # latest raw request JSON
opencode-trace latest messages   # latest request messages
opencode-trace latest tools      # latest tool schemas
opencode-trace latest output     # latest assistant output
opencode-trace latest transcript # request messages + assistant output
opencode-trace latest sample     # one training sample
opencode-trace turn sample       # all samples for the latest user turn
opencode-trace dataset           # alias for turn sample
```

## Log Files

Raw JSON traces are written to:

```text
~/.local/share/opencode-trace/logs/*.json
```

Each file contains the full wire-level request and response. Authorization headers are forwarded upstream but are not written to disk.

## Security Notes

The proxy records sensitive data:

- system prompts
- user prompts
- tool schemas
- tool outputs
- file paths
- code snippets
- model reasoning fields, if returned by the provider

Protect the trace directory:

```sh
chmod 700 ~/.local/share/opencode-trace
chmod 700 ~/.local/share/opencode-trace/logs
```

Only run this on machines where local trace capture is allowed by your company's security and data policy.

## Troubleshooting

Check service logs:

```sh
journalctl --user -u opencode-trace-proxy -f
```

Check OpenCode resolved config:

```sh
opencode debug config
```

Make sure your provider has:

```json
"baseURL": "http://127.0.0.1:5010/v1"
```

If `opencode-trace list` is empty:

1. Check the proxy is running: `curl http://127.0.0.1:5010/health`
2. Restart OpenCode.
3. Run a new OpenCode task.
4. Check `RAW_TRACE_DIR` in the systemd service.
