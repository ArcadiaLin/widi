export type AgentProfile = {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly systemPrompt: string;
  readonly persist: boolean; // 是否会持久化 AgentHarness 的状态，默认为 false
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
