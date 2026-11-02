# Custom Model Providers

Flywheel can use models from any server that speaks the OpenAI chat-completions API. This includes local servers such as llama.cpp, Ollama, LM Studio, and vLLM, and hosted endpoints such as Groq, Together, or a company proxy. You declare the endpoint once in your config file, store its API key once, and its models then appear in Flywheel like any built-in provider's models.

You do not write any code. A custom provider is a few lines of TOML.

## 1. Declare the provider

Open your Flywheel config file, `flywheel.toml`, in your Flywheel data directory (`~/.flywheel/flywheel.toml` unless you moved it). Add a `[custom_providers.<id>]` table. The `<id>` is a short name you choose. It must be lowercase, start with a letter, and use only letters, digits, `_`, or `-`.

```toml
[custom_providers.groq]
display_name = "Groq"
base_url = "https://api.groq.com/openai/v1"
models = ["llama-3.3-70b-versatile", "qwen-2.5-coder-32b"]
```

A local server works the same way:

```toml
[custom_providers.local_llama]
display_name = "Local llama.cpp"
base_url = "http://localhost:8080/v1"
models = ["llama-3.3-70b"]
context_limit = 32768
```

Fields:

| Field | Required | Meaning |
|---|---|---|
| `base_url` | yes | The endpoint's OpenAI-compatible base URL. Flywheel sends requests to `<base_url>/chat/completions`. |
| `models` | yes | The exact model ids this endpoint serves. Only these models route to this provider. |
| `display_name` | no | The name shown in Flywheel. Defaults to the id. |
| `catalog_id` | no | A [models.dev](https://models.dev) provider key. When set (or when your `<id>` matches one, like `groq` above), Flywheel reads that provider's real context limits and reference pricing for your models. |
| `context_limit` | no | Context window in tokens for models that models.dev does not know. Defaults to 128000. |

If an entry has a valid schema shape but fails a semantic check, such as an invalid provider id or a non-HTTP URL, Flywheel logs a warning that names the entry and ignores only that entry. An unknown field or an invalid schema shape is a strict configuration error, so Flywheel rejects the whole file and starts with its fallback configuration.

## 2. Store the API key

Keys never go in `flywheel.toml`. Open Flywheel, type `/auth`, and your provider appears under **Model Providers**. Select it, paste the key, and press Enter. The list shows it as `stored`. To remove the key, highlight the provider and press `d`.

You can edit the config while Flywheel is running: the auth list picks up new, changed, and removed entries without a restart. If an entry is invalid, it appears in the list as `misconfigured`; selecting it shows exactly what is wrong so you can fix the TOML.

For a local server that requires no key, enter any placeholder value such as `none`; the OpenAI protocol requires that a value is sent.

The same works from the command line if you prefer it:

```
flywheel auth login --provider groq
flywheel auth status
flywheel auth logout --provider groq
```

## 3. Use the models

Your declared models now behave like any other model:

- They appear in the model picker, grouped under your provider.
- You can assign them to roles in `flywheel.toml`, for example `[roles.chat] model = "llama-3.3-70b-versatile"`.
- Requests route through the standard provider chain. A model that only your custom provider declares always routes to it. A model that a built-in provider also serves (for example, declaring `gpt-4o` behind a proxy) prefers the built-in provider first.

## Cost and context accounting

If Flywheel finds your model in the models.dev catalog (directly, or through `catalog_id`), it uses that entry's real context limit and API-equivalent pricing. Otherwise the model is accounted at zero cost with the `context_limit` you configured. Zero cost does not mean free; it means Flywheel does not know your endpoint's prices.

## Limits

- Only OpenAI chat-completions endpoints are supported. Anthropic-style and Gemini-style wires are not.
- Authentication is API-key only. OAuth device flows are not available for custom providers.
- Custom providers have no toggle in the Settings screen; the config entry's presence is their enablement.
- Config edits apply to the running app for the auth list and for new chats. A chat that is already open keeps the providers it started with; press ctrl+n for a fresh one.

## Troubleshooting

- Provider shows `misconfigured` in `/auth`: select it to see the exact reason, then fix the entry in `flywheel.toml`. The row updates when you save the file.
- Provider missing from `/auth`: the `[custom_providers.<id>]` table is missing, or the whole config file failed to parse. Check the file for TOML syntax errors.
- Model missing from the picker: confirm the model id is listed in `models` exactly, and that `/auth` shows the provider as `stored`.
- "Cannot determine model family": the model id is not declared under any `[custom_providers]` entry, and no built-in provider recognizes it. Add it to `models`.
- Requests fail against a local server: confirm the server is running and that `base_url` includes the `/v1` prefix your server expects.
