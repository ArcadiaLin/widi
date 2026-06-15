# WIDI Pi Context

This glossary defines the core language used by `widi-pi`, a multi-agent runtime built around Pi AgentHarness. It records domain terms only, not implementation plans or API details.

## Language

**Core**:
The recoverable and diagnosable agent runtime foundation of `widi-pi`, including orchestration, dependency registries, channels, diagnostics, sessions, and runtime boundaries. Product interaction modes, concrete UI commands, and coding-agent presets are built on top of Core rather than being Core primitives.
_Avoid_: Product feature set, preset, application adapter

**Orchestrator**:
The Core runtime coordinator that keeps cross-agent lifecycle, dependency resolution, channel routing, diagnostics, and harness assembly on the observable main path. It is not the owner of file parsing, UI presentation, product modes, or extension-private behavior.
_Avoid_: Master controller, application adapter, feature container

**Agent**:
A WIDI runtime entity identified by one **AgentId** and coordinated by the **Orchestrator**. An Agent is assembled from a profile, a Pi harness, a session, model state, resolved dependencies, and runtime status.
_Avoid_: AgentHarness, profile, session

**AgentId**:
The runtime-local identity of one **Agent** within an orchestrated WIDI runtime. It may be persisted as a recovery reference or session identifier, but it is not a globally stable profile id.
_Avoid_: Profile id, global primary key

**Agent Lifecycle**:
The Core-owned primitive lifecycle of one **Agent**, including creation, resume, availability changes, disposal, and runtime updates. Extensions and presets may coordinate multiple Agents, but they request lifecycle changes through Core rather than privately owning the agent registry.
_Avoid_: Product coordination, extension-private registry

**Unavailable Agent**:
An **Agent** known to the **Orchestrator** but unable to run because required dependencies or runtime boundaries are missing or failed. Unavailable Agent is a runtime status with diagnostics, not a synonym for every creation failure.
_Avoid_: Deleted agent, failed spawn, missing profile

**AgentHarness**:
The Pi single-agent execution kernel used by one WIDI **Agent** to run model turns, tools, resources, and the Pi session tree. It does not represent the whole WIDI Agent.
_Avoid_: Agent, orchestrator

**AgentProfile**:
The declarative configuration used to assemble one or more **Agents**. It is not an Agent instance and does not own runtime objects.
_Avoid_: Agent, harness, runtime state

**ProfileId**:
The stable declaration identity of an **AgentProfile**, used for registry lookup, recovery references, and diagnostics. It is not a filename and not an **AgentId**.
_Avoid_: Filename, AgentId, label

**DefaultProfile**:
A caller-provided **AgentProfile** used as the default input when creating a new **Agent** without an explicit profile. It is not an automatic resume fallback unless caller policy explicitly chooses that behavior.
_Avoid_: Core built-in profile, resume fallback

**Profile Registry**:
The Core dependency registry that resolves a **ProfileId** into a sourced **AgentProfile** and reports discovery, priority, conflict, and validation diagnostics. It may use profile loaders, but it owns profile indexing semantics.
_Avoid_: Markdown loader, resolveProfile callback, default profile

**Profile Capability**:
A declaration on an **AgentProfile** describing which runtime behaviors the assembled **Agent** is allowed to participate in. It connects profile intent to runtime policy, channel policy, and tool visibility, but it is not a tool list or a Core Capability.
_Avoid_: Core capability, tool list, product feature

**Resource**:
A declarative external dependency referenced by a profile or runtime policy and resolved through Core dependency handling. A Resource may produce diagnostics and may or may not become a Harness Resource.
_Avoid_: Runtime object, file contents, tool implementation

**Resource Loader**:
The dependency component that reads and parses resource declarations from concrete sources such as files. A Resource Loader does not own resource identity, priority, or conflict policy.
_Avoid_: Resource registry, orchestrator

**Resource Registry**:
The Core dependency registry that organizes resolved **Resources** by identity and reports duplicate, priority, source, and validation diagnostics. It may use Resource Loaders, but it owns resource indexing semantics.
_Avoid_: File loader, harness resources array

**Dependency**:
An external declaration or available capability that **Core** must resolve to assemble an **Agent** runtime, including profiles, resources, tools, extensions, models, auth, and runtime adapters. Resource is one kind of Dependency, not the umbrella for all dependencies.
_Avoid_: Resource, runtime state, implementation detail

**Model Dependency**:
The dependency on a resolvable model provider and model identity needed by an **Agent** runtime. Missing or unavailable models produce diagnostics rather than disappearing into harness callbacks.
_Avoid_: Model object, auth secret

**Auth Dependency**:
The dependency on credentials or headers required for model, runtime, tool, or external capability access. Auth Dependencies are resolved through controlled storage or providers and never stored in session metadata.
_Avoid_: API key in session, runtime object

**Harness Resource**:
A resolved **Resource** passed into a Pi **AgentHarness** as part of its resource set, such as a skill or prompt template. Harness Resources are a subset of WIDI Resources.
_Avoid_: Any dependency, profile, extension

**Runtime State**:
The in-process state needed to run an **Agent**, such as harness instances, resolved dependencies, active extensions, model objects, channel queues, and availability. Runtime State is not automatically recoverable across processes.
_Avoid_: Persisted state, session metadata

**Runtime Boundary**:
A controlled boundary through which Core exposes external capabilities such as filesystem, shell, sandbox, remote runtime, model providers, auth, MCP, or external transport. ExecutionEnv is one Runtime Boundary, not the whole concept.
_Avoid_: Unrestricted host access, runtime state

**Persisted State**:
The small, stable, serializable state used to recover runtime, such as Pi session history and references to external declarations. Persisted State does not contain runtime objects, API keys, extension instances, tool functions, or large resource contents.
_Avoid_: Runtime state, object snapshot, secret storage

**Session**:
The Pi single-agent history produced by one **AgentHarness**, including messages, tool results, model/tool/thinking changes, compaction, branch summaries, and branch leaf state. Its metadata may carry small recovery references used by WIDI to rebuild surrounding runtime, but the session body is not the full **Agent** state.
_Avoid_: Agent state store, channel log, multi-session store

**Recovery Reference**:
A small, stable, serializable reference stored in metadata so WIDI can rebuild runtime dependencies during resume. It may identify declarations such as profiles, presets, extensions, or resources, but it is not extension runtime state or a snapshot of loaded objects.
_Avoid_: Extension state, object snapshot, extra info

**Channel**:
The Core communication semantics for routing and presenting messages between agents, humans, extensions, policy, and external transports. A Channel defines source visibility, target, timing, async behavior, and delivery strategy; it is not a session or bare transport.
_Avoid_: Message bus, session log, transport

**Diagnostic**:
A structured Core record of a profile, dependency, runtime, or extension problem. A Diagnostic is not UI copy and not merely a warning; severity and policy decide whether execution continues, degrades, marks an Agent unavailable, or fails.
_Avoid_: Log line, thrown error, UI message

**Human Request**:
A human-facing request pattern within **Channel** semantics that may wait for a human response. It can be initiated by a tool call, in which case the response enters the Pi **Session** as a tool result; outside a tool call it remains channel/runtime interaction.
_Avoid_: Session message, standalone tool, UI prompt

**Core Capability**:
A native runtime ability provided by **Core** and reachable through controlled Core APIs. Core Capabilities may be invoked by the **Orchestrator**, extensions, adapters, or built-in tools without making the tool itself the owner of the capability.
_Avoid_: Tool, product command, extension-private function

**Built-in Tool**:
A predefined tool adapter that exposes a **Core Capability** to an **AgentHarness** and the model. A Built-in Tool is an access path, not the underlying capability.
_Avoid_: Core capability, product command, extension

**Tool Visibility**:
The declaration or resolved result of whether a tool is added to an **AgentHarness** and made visible to the model. Tool Visibility does not define what an Agent is allowed to do; that belongs to **Profile Capability** and runtime policy.
_Avoid_: Capability, tool registry, tool implementation

**Tool Registry**:
The Core dependency registry that resolves built-in tools, extension-contributed tools, adapter-contributed tools, conflicts, availability, and diagnostics. It produces the tools visible to a specific **AgentHarness** from Profile Capability, Tool Visibility, and runtime policy.
_Avoid_: Orchestrator tool array, profile tools field

**Extension**:
A runtime participant activated by **Core** that can observe, intercept, supplement, or rewrite Core Capability execution through controlled hooks and contributions. It may contribute tools, channels, resource providers, diagnostics, and adapter interactions, but it does not privately own Core persisted state.
_Avoid_: Plugin package, sidecar controller, private runtime

**Extension Declaration**:
A stable dependency declaration that identifies an extension required or requested by a profile, preset, or configuration. It is recoverable and resolvable, but it is not an activated runtime object.
_Avoid_: Extension instance, runtime state

**Extension Missing Policy**:
The resolution policy attached to an **Extension Declaration** that decides how Core handles a missing declared extension. It does not define activation failure or runtime diagnostic behavior.
_Avoid_: Activation policy, runtime error handling

**Extension Instance**:
An activated **Extension** participant in the current runtime. It belongs to **Runtime State** and is never stored directly in session metadata.
_Avoid_: Extension declaration, recovery reference

**Extension Hook Permission**:
The permission granted to an **Extension** at a Core hook point, such as observing, intercepting, mutating input or output, or invoking controlled Core Capabilities. Extension freedom is expressed through these permissions, not through bypassing Core ownership.
_Avoid_: Unrestricted access, side channel

**Extension-owned Storage**:
Storage controlled by an **Extension** or **Preset** for its own Product Interaction Modes and multi-session coordination. Core may provide boundaries, hooks, diagnostics, and references, but it does not own or interpret the storage internals.
_Avoid_: Core persisted state, session body, recovery reference

**Preset**:
A product-oriented assembly built on **Core**, such as a coding-agent setup with default profiles, tool visibility, preinstalled extensions, adapter configuration, and policy defaults. A Preset is not a Core primitive.
_Avoid_: Core, profile, extension

**Product Interaction Mode**:
A user-facing interaction pattern assembled by a **Preset** or **Extension** using Core capabilities, agents, sessions, channels, tools, and extension-owned storage when needed. Core does not define its lifecycle or state model.
_Avoid_: Core primitive, multi-session core abstraction

## Flagged Ambiguities

**Run**:
Do not use Run as a Core storage or lifecycle boundary. Multiple-session coordination belongs to extensions or presets that use Core Agents, Sessions, Channels, Diagnostics, and their own storage when needed.

**Channel Log**:
Do not use Channel Log as Core persisted state. Core may emit channel events for observability, while persistent channel history belongs to adapters, extensions, or presets when they need it.

**Profile Fallback**:
Do not treat fallback to a default profile as universal Core resume behavior. Missing resume profiles produce diagnostics; fallback, failure, user selection, or marking an Agent unavailable are policy decisions owned by the caller layer.

**Profile Override**:
Do not allow temporary profile overrides for persistent Agents. Ephemeral Agents may use profile overrides as one-time runtime assembly input, but persistent Agents must recover from stable declarations and recovery references rather than hidden profile snapshots stored in session metadata.

**Duplicate Resource**:
Do not silently merge or override duplicate Resources in Core. Duplicate resource identities produce diagnostics; explicit override semantics, if needed, belong to a visible preset or extension policy.

## Example Dialogue

Developer: Should team interaction behavior be part of Core?

Domain expert: No. Core provides the channel and orchestration foundation; team interaction behavior is an extension or preset that uses those foundations.
