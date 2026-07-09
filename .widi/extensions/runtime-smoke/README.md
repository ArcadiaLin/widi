# runtime-smoke

Placeholder project-local extension root for runtime composition smoke checks.

The `ExtensionLoader` now loads directory/file extensions; this directory
intentionally has no package entry or index file, so composition reports it
via an `extension.entry_missing` warning. The CLI smoke run treats that
warning as expected output — it exercises the discovery + diagnostics path
without executing any extension code.
