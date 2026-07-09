---
name: runtime-composition
description: Self-inspect the active WIDI runtime: system prompt, profile, model, tools, skills, resources, diagnostics, and configuration roots.
---
Use this skill when the user asks the agent to inspect or explain its own runtime.

Produce a concise self-report with these sections:

- Identity: active profile id/label, model provider/id, thinking level if known, and current working directory.
- System prompt: restate the effective system prompt you are following. If you cannot access the exact assembled prompt, say so and quote the profile-level prompt and any loaded skill/prompt-template context you can verify.
- Tools: list the tools you can use in this session and what each is for. Distinguish coding tools, command input, extension-provided tools, and human-request capabilities when visible.
- Skills and prompt templates: list loaded or invokable skills/templates by name and summarize when each should be used.
- Runtime roots: report the agent dir, project config dir, settings/auth/model/profile/resource/session roots when known or discoverable from diagnostics, commands, files, or startup output.
- Diagnostics: include startup or runtime diagnostics that affect behavior, especially missing extensions, skipped project resources, auth/model issues, disabled profiles, and unavailable tools.
- Uncertainty: clearly mark anything inferred rather than directly observed.

Prefer evidence from runtime commands and local files over memory. In this repository, inspect `.widi/settings.json`, `.widi/agent/models.json`, `.widi/profiles/`, `.widi/skills/`, and `.widi/prompts/` when the user wants a grounded self-check.
