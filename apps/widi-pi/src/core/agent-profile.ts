import type {
  ExecutionEnv,
  FileInfo
} from "@earendil-works/pi-agent-core";

export type AgentProfile = {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly systemPrompt: string;
  /** Whether the agent's state should be persisted. */
  readonly persist: boolean;
  readonly tools?: readonly string[];
  readonly skills?: readonly string[];
  readonly promptTemplates?: readonly string[];

  readonly capabilities?: {
    readonly acceptsUserInput?: boolean;
    readonly canSpawn?: boolean;
    readonly canRequestUser?: boolean;
    readonly maibox?: boolean;
  }

  readonly extensionReferences?: Record<string, unknown>;
}

export type AgentProfileReference = {
  readonly id: string;
  readonly label?: string;
}

export type AgentProfileDiagnosticCode =
  | "file_info_failed"
  | "list_failed"
  | "read_failed"
  | "parse_failed"
  | "invalid_metadata";

/** Warning produced while loading skills. */
export type AgentProfileDiagnostic = {
  /** Diagnostic severity. Currently only warnings are emitted. */
  readonly type: "warning";
  /** Stable diagnostic code. */
  readonly code: AgentProfileDiagnosticCode;
  /** Human-readable diagnostic message. */
  readonly message: string;
  /** Path associated with the diagnostic. */
  readonly path: string;
}

export type AgentProfileSource = {
  readonly kind: "file";
  readonly path: string;
}

export type SourcedAgentProfile = {
  readonly profile: AgentProfile;
  readonly source: AgentProfileSource;
}

export interface AgentProfileLoaderOptions {
  readonly executionEnv: ExecutionEnv;
}

type AgentProfileFrontmatter = {
  readonly id?: unknown;
  readonly label?: unknown;
  readonly description?: unknown;
  readonly persist?: unknown;
  readonly tools?: unknown;
  readonly skills?: unknown;
  readonly promptTemplates?: unknown;
  readonly "prompt-templates"?: unknown;
  readonly [key: string]: unknown;
}

export function toAgentProfileReference(profile: Pick<AgentProfile, "id" | "label">): AgentProfileReference {
  return {
    id: profile.id,
    label: profile.label,
  };
}

export class AgentProfileLoader {
  private readonly _executionEnv: ExecutionEnv;

  constructor(options: AgentProfileLoaderOptions) {
    this._executionEnv = options.executionEnv;
  }

  /**
   * Load markdown profile files from explicit files or direct children of directories.
   *
   * This skeleton establishes the loader boundary and diagnostics shape. The final markdown schema can later add richer
   * frontmatter, inheritance, and resource validation without changing session metadata.
   */
  async loadProfiles(paths: string | readonly string[]): Promise<{
    profiles: SourcedAgentProfile[];
    diagnostics: AgentProfileDiagnostic[];
  }> {
    const profiles: SourcedAgentProfile[] = [];
    const diagnostics: AgentProfileDiagnostic[] = [];

    for (const path of Array.isArray(paths) ? paths : [paths]) {
      const result = await this._loadPath(path);
      profiles.push(...result.profiles);
      diagnostics.push(...result.diagnostics);
    }

    return { profiles, diagnostics };
  }

  async loadProfile(path: string): Promise<{
    profile: AgentProfile | undefined;
    diagnostics: AgentProfileDiagnostic[];
  }> {
    const result = await this.loadProfiles(path);
    return {
      profile: result.profiles[0]?.profile,
      diagnostics: result.diagnostics,
    };
  }

  private async _loadPath(path: string): Promise<{
    profiles: SourcedAgentProfile[];
    diagnostics: AgentProfileDiagnostic[];
  }> {
    const infoResult = await this._executionEnv.fileInfo(path);
    if (!infoResult.ok) {
      if (infoResult.error.code === "not_found") {
        return { profiles: [], diagnostics: [] };
      }
      return {
        profiles: [],
        diagnostics: [{
          type: "warning",
          code: "file_info_failed",
          message: infoResult.error.message,
          path,
        }],
      };
    }

    const kind = await this._resolveKind(infoResult.value);
    if (kind === "directory") {
      return await this._loadDirectory(infoResult.value.path);
    }
    if (kind === "file" && infoResult.value.name.endsWith(".md")) {
      const result = await this._loadFile(infoResult.value.path);
      return {
        profiles: result.profile ? [{ profile: result.profile, source: { kind: "file", path: infoResult.value.path } }] : [],
        diagnostics: result.diagnostics,
      };
    }

    return { profiles: [], diagnostics: [] };
  }

  private async _loadDirectory(path: string): Promise<{
    profiles: SourcedAgentProfile[];
    diagnostics: AgentProfileDiagnostic[];
  }> {
    const entriesResult = await this._executionEnv.listDir(path);
    if (!entriesResult.ok) {
      return {
        profiles: [],
        diagnostics: [{
          type: "warning",
          code: "list_failed",
          message: entriesResult.error.message,
          path,
        }],
      };
    }

    const profiles: SourcedAgentProfile[] = [];
    const diagnostics: AgentProfileDiagnostic[] = [];
    for (const entry of entriesResult.value.sort((a, b) => a.name.localeCompare(b.name))) {
      const kind = await this._resolveKind(entry);
      if (kind !== "file" || !entry.name.endsWith(".md")) continue;

      const result = await this._loadFile(entry.path);
      if (result.profile) {
        profiles.push({ profile: result.profile, source: { kind: "file", path: entry.path } });
      }
      diagnostics.push(...result.diagnostics);
    }

    return { profiles, diagnostics };
  }

  private async _loadFile(path: string): Promise<{
    profile: AgentProfile | undefined;
    diagnostics: AgentProfileDiagnostic[];
  }> {
    const rawContent = await this._executionEnv.readTextFile(path);
    if (!rawContent.ok) {
      return {
        profile: undefined,
        diagnostics: [{
          type: "warning",
          code: "read_failed",
          message: rawContent.error.message,
          path,
        }],
      };
    }

    const parsed = parseProfileMarkdown(rawContent.value);
    if (!parsed.ok) {
      return {
        profile: undefined,
        diagnostics: [{
          type: "warning",
          code: "parse_failed",
          message: parsed.error,
          path,
        }],
      };
    }

    const { frontmatter, body } = parsed.value;
    const diagnostics: AgentProfileDiagnostic[] = [];
    const id = readString(frontmatter.id) ?? basenameEnvPath(path).replace(/\.md$/i, "");
    const label = readString(frontmatter.label) ?? id;
    const description = readString(frontmatter.description);
    const persist = readBoolean(frontmatter.persist) ?? false;
    const tools = readStringArray(frontmatter.tools);
    const skills = readStringArray(frontmatter.skills);
    const promptTemplates = readStringArray(frontmatter.promptTemplates ?? frontmatter["prompt-templates"]);

    if (!id) {
      diagnostics.push({
        type: "warning",
        code: "invalid_metadata",
        message: "Profile id is missing.",
        path,
      });
      return { profile: undefined, diagnostics };
    }

    if (!body.trim()) {
      diagnostics.push({
        type: "warning",
        code: "invalid_metadata",
        message: "Profile markdown body is empty; systemPrompt will be empty until the schema is finalized.",
        path,
      });
    }

    return {
      profile: {
        id,
        label,
        description,
        systemPrompt: body,
        persist,
        tools,
        skills,
        promptTemplates,
      },
      diagnostics,
    };
  }

  private async _resolveKind(info: FileInfo): Promise<"file" | "directory" | undefined> {
    if (info.kind === "file" || info.kind === "directory") {
      return info.kind;
    }

    const canonicalPath = await this._executionEnv.canonicalPath(info.path);
    if (!canonicalPath.ok) {
      return undefined;
    }
    const target = await this._executionEnv.fileInfo(canonicalPath.value);
    if (!target.ok) {
      return undefined;
    }
    return target.value.kind === "file" || target.value.kind === "directory" ? target.value.kind : undefined;
  }
}

function parseProfileMarkdown(content: string):
  | { ok: true; value: { frontmatter: AgentProfileFrontmatter; body: string } }
  | { ok: false; error: string } {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { ok: true, value: { frontmatter: {}, body: normalized } };
  }

  const endIndex = normalized.indexOf("\n---", 4);
  if (endIndex === -1) {
    return { ok: false, error: "Profile frontmatter is missing a closing --- marker." };
  }

  const frontmatter: Record<string, unknown> = {};
  const frontmatterText = normalized.slice(4, endIndex);
  for (const line of frontmatterText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex === -1) {
      return { ok: false, error: `Cannot parse frontmatter line: ${trimmed}` };
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    frontmatter[key] = parseSimpleFrontmatterValue(rawValue);
  }

  return {
    ok: true,
    value: {
      frontmatter,
      body: normalized.slice(endIndex + 4).trim(),
    },
  };
}

function parseSimpleFrontmatterValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((item) => unquote(item.trim())).filter(Boolean);
  }
  return unquote(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
  return items.length > 0 ? items : undefined;
}

function unquote(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function basenameEnvPath(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  const slashIndex = normalized.lastIndexOf("/");
  return slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
}
