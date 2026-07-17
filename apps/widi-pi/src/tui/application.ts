import { homedir } from "node:os";
import { join } from "node:path";
import { ProcessTerminal, setKeybindings, TUI } from "@earendil-works/pi-tui";
import type {
	AgentOrchestrator,
	OrchestratorEvent,
} from "../core/agent-orchestrator.ts";
import type { AgentRecordSnapshot } from "../core/agent-record.ts";
import type { InputResult } from "../core/command.ts";
import {
	type OrchestratorDiagnostic,
	OrchestratorError,
} from "../core/diagnostics.ts";
import {
	createWidiRuntime,
	type WidiRuntime,
} from "../core/runtime-service.ts";
import { AgentSelectorController } from "./agent-selector.ts";
import { WidiCommandAutocompleteProvider } from "./autocomplete.ts";
import {
	AgentStripView,
	agentLabel,
	ChatView,
	FooterView,
	HeaderView,
	NoticeView,
	StatusView,
} from "./components/views.ts";
import { WidiEditor } from "./editor.ts";
import { applyAgentSnapshot, EventProjector } from "./event-projector.ts";
import { HumanRequestController } from "./human-request.ts";
import { createWidiKeybindings } from "./keybindings.ts";
import { hydrateSessionEntries } from "./session-hydrator.ts";
import {
	createTuiApplicationState,
	ensureAgentProjection,
	setActiveAgent,
	type TuiApplicationState,
} from "./state.ts";
import { editorTheme } from "./theme.ts";

const NOTIFICATION_TTL_MS = 5_000;

export interface WidiTuiOptions {
	readonly cwd: string;
	readonly agentDir?: string;
	readonly profileId?: string;
	readonly runtime?: WidiRuntime;
}

export class WidiTuiApplication {
	readonly runtime: WidiRuntime;
	readonly orchestrator: AgentOrchestrator;
	readonly state: TuiApplicationState;
	readonly tui: TUI;

	private readonly projector: EventProjector;
	private readonly editor: WidiEditor;
	private readonly humanRequests: HumanRequestController;
	private readonly agentSelector: AgentSelectorController;
	private unsubscribeEvents?: () => void;
	private unregisterClient?: () => void;
	private readonly hydrationGeneration = new Map<string, number>();
	private readonly commandGeneration = new Map<string, number>();
	private readonly hydratedAgents = new Set<string>();
	private readonly notificationTimers = new Map<string, NodeJS.Timeout>();
	private readonly pendingTasks = new Set<Promise<unknown>>();
	private readonly lifecycleTasks = new Set<Promise<unknown>>();
	private readonly drafts = new Map<string, string>();
	private animationTimer?: NodeJS.Timeout;
	private started = false;
	private shutdownPromise?: Promise<void>;
	private resolveClosed?: () => void;
	private readonly closed = new Promise<void>((resolve) => {
		this.resolveClosed = resolve;
	});
	private readonly onSigterm = () => {
		void this.shutdown("SIGTERM").catch(() => {});
	};
	private readonly onSigint = () => {
		void this.shutdown("SIGINT").catch(() => {});
	};

	private constructor(runtime: WidiRuntime) {
		this.runtime = runtime;
		this.orchestrator = runtime.orchestrator;
		this.state = createTuiApplicationState();
		this.projector = new EventProjector(this.state);

		const keybindings = createWidiKeybindings();
		setKeybindings(keybindings);
		this.tui = new TUI(new ProcessTerminal());
		this.editor = new WidiEditor(this.tui, editorTheme, {
			paddingX: 1,
			autocompleteMaxVisible: 8,
		});
		this.humanRequests = new HumanRequestController({
			tui: this.tui,
			resolveAgentLabel: (agentId) => this.resolveAgentLabel(agentId),
		});
		this.agentSelector = new AgentSelectorController(
			this.tui,
			this.state,
			(agentId) => this.switchAgent(agentId),
		);

		this.tui.addChild(new HeaderView(this.state));
		this.tui.addChild(new NoticeView(this.state));
		this.tui.addChild(new ChatView(this.state));
		this.tui.addChild(new StatusView(this.state));
		this.tui.addChild(this.editor);
		this.tui.addChild(new FooterView(this.state, runtime.services.cwd));
		this.tui.addChild(new AgentStripView(this.state));
		this.tui.setFocus(this.editor);

		this.editor.onSubmit = (text) => {
			this.track(this.submit(text));
		};
		this.editor.onChange = (text) => {
			const agentId = this.state.activeAgentId;
			if (agentId) this.drafts.set(agentId, text);
		};
		this.editor.onOpenAgents = () => this.agentSelector.open();
		this.editor.onInterrupt = () => this.interrupt();
		this.editor.onExit = () => {
			void this.shutdown("user exit").catch(() => {});
		};
	}

	static async create(options: WidiTuiOptions): Promise<WidiTuiApplication> {
		const runtime =
			options.runtime ??
			(await createWidiRuntime({
				cwd: options.cwd,
				agentDir: options.agentDir ?? join(homedir(), ".widi"),
				defaultProfileId: options.profileId,
			}));
		return new WidiTuiApplication(runtime);
	}

	async run(): Promise<void> {
		if (this.started) return await this.closed;
		this.started = true;
		this.installLifecycleHandlers();
		this.unsubscribeEvents = this.orchestrator.subscribe((event) => {
			this.handleEvent(event);
		});
		this.unregisterClient = this.orchestrator.registerClient({
			id: "tui",
			requestHuman: (request, signal) =>
				this.humanRequests.request(request, signal),
		});

		this.tui.start();
		this.animationTimer = setInterval(() => {
			const agentId = this.state.activeAgentId;
			const agent = agentId ? this.state.agents.get(agentId) : undefined;
			if (
				agent &&
				[...agent.extensionStatuses.values()].some(
					(entry) =>
						entry.status.progress !== undefined &&
						entry.status.progress.total === undefined,
				)
			) {
				this.tui.requestRender();
			}
		}, 160);
		this.animationTimer.unref();
		this.tui.terminal.setTitle("WIDI");
		// Routine resolution facts collapse to one startup line; only actual
		// problems occupy the persistent notice area.
		for (const diagnostic of this.runtime.diagnostics) {
			if (diagnostic.severity !== "info") this.projectDiagnostic(diagnostic);
		}
		this.addStartupSummary();
		this.tui.requestRender();

		try {
			const agentId = await this.trackLifecycle(this.orchestrator.spawnAgent());
			if (this.state.shuttingDown) return await this.closed;
			await this.syncAgent(agentId);
			this.switchAgent(agentId);
			this.refreshCommands(agentId);
		} catch (error) {
			await this.recoverInitialSpawnFailure(error);
		}
		this.tui.requestRender();
		return await this.closed;
	}

	async shutdown(reason = "tui exit"): Promise<void> {
		if (this.shutdownPromise) return await this.shutdownPromise;
		this.shutdownPromise = this.performShutdown(reason);
		return await this.shutdownPromise;
	}

	private async performShutdown(reason: string): Promise<void> {
		this.state.shuttingDown = true;
		this.editor.disableSubmit = true;
		this.agentSelector.close();
		this.humanRequests.close();
		this.unregisterClient?.();
		this.unregisterClient = undefined;
		this.unsubscribeEvents?.();
		this.unsubscribeEvents = undefined;
		for (const timer of this.notificationTimers.values()) clearTimeout(timer);
		this.notificationTimers.clear();
		if (this.animationTimer) clearInterval(this.animationTimer);
		this.animationTimer = undefined;
		this.removeLifecycleHandlers();
		try {
			await this.orchestrator.disposeAll(reason);
			await Promise.allSettled([...this.lifecycleTasks, ...this.pendingTasks]);
			await this.orchestrator.disposeAll(`${reason} (final cleanup)`);
		} catch {
			// Shutdown is best-effort; terminal restoration is mandatory.
		} finally {
			this.tui.stop();
			this.resolveClosed?.();
			this.resolveClosed = undefined;
		}
	}

	private handleEvent(event: OrchestratorEvent): void {
		this.projector.apply(event);

		switch (event.type) {
			case "agent_spawned":
			case "agent_resumed":
				this.schedule(() => this.syncAgent(event.agentId));
				this.schedule(() => this.hydrateAgent(event.agentId));
				this.refreshCommands(event.agentId);
				break;
			case "agent_status_changed":
				this.schedule(() => this.syncAgent(event.agentId));
				this.refreshCommands(event.agentId);
				this.updateEditorAvailability();
				break;
			case "agent_session_info_changed":
				if (event.agentId === this.state.activeAgentId) {
					this.updateTerminalTitle();
				}
				break;
			case "agent_session_forked":
				this.projector.beginHydration(event.agentId);
				this.schedule(() => this.hydrateAgent(event.agentId));
				break;
			case "extension_notification":
				this.expireNotification(event.presentationId);
				break;
			case "human_request_timeout":
			case "human_request_cancelled":
				this.humanRequests.cancelRequest(event.requestId);
				break;
			case "command_completed": {
				const nextAgentId = navigationAgentId(event.result);
				if (nextAgentId)
					this.schedule(() => this.activateNavigationAgent(nextAgentId));
				if (event.command.name === "reload")
					this.refreshCommands(event.agentId);
				break;
			}
			case "agent_harness_event":
				if (
					event.event.type === "session_tree" ||
					event.event.type === "session_compact"
				) {
					this.projector.beginHydration(event.agentId);
					this.schedule(() => this.hydrateAgent(event.agentId));
				}
				break;
			default:
				break;
		}

		this.tui.requestRender();
	}

	private async submit(rawText: string): Promise<void> {
		const text = rawText.trim();
		if (!text || this.state.shuttingDown) return;
		const agentId = this.state.activeAgentId;
		if (!agentId) {
			this.restoreEditor(rawText, agentId);
			this.addApplicationNotice("No active agent is available.");
			return;
		}
		const agent = ensureAgentProjection(this.state, agentId);
		if (
			agent.status === "unavailable" ||
			agent.status === "disposed" ||
			!agent.snapshot?.hasHarness
		) {
			this.restoreEditor(rawText, agentId);
			this.addApplicationNotice(
				`Agent ${agentLabel(agent)} cannot accept input (${agent.status}).`,
				agentId,
			);
			return;
		}

		const lineCommandCandidate = agent.commands.some(
			(command) =>
				command.placement === "line" && text.startsWith(command.trigger),
		);
		if (agent.status === "running" && !lineCommandCandidate) {
			this.restoreEditor(rawText, agentId);
			this.addApplicationNotice(
				"Agent is running. Use /steer:<text> or /follow-up:<text>.",
				agentId,
			);
			return;
		}

		agent.pendingInput = {
			originalText: rawText,
			submittedAt: new Date().toISOString(),
			lineCommandCandidate,
		};
		this.editor.addToHistory(rawText);
		this.tui.requestRender();

		try {
			const result = await this.orchestrator.inputAgent(agentId, text);
			await this.handleInputResult(agentId, rawText, result);
		} catch (error) {
			const pending = ensureAgentProjection(this.state, agentId).pendingInput;
			ensureAgentProjection(this.state, agentId).pendingInput = undefined;
			if (pending) this.restoreEditor(rawText, agentId);
			if (error instanceof OrchestratorError) {
				this.projectDiagnostic(error.diagnostic);
			} else {
				this.addApplicationNotice(errorMessage(error), agentId);
			}
			this.tui.requestRender();
		}
	}

	private async handleInputResult(
		agentId: string,
		originalText: string,
		result: InputResult,
	): Promise<void> {
		const agent = ensureAgentProjection(this.state, agentId);
		if (result.kind !== "prompt") agent.pendingInput = undefined;
		if (result.kind === "blocked") {
			this.restoreEditor(originalText, agentId);
			this.addApplicationNotice(
				result.reason
					? `Input blocked by ${result.blockedBy}: ${result.reason}`
					: `Input blocked by ${result.blockedBy}.`,
				agentId,
			);
		}
		if (result.kind === "command") {
			const nextAgentId = navigationAgentId(result.value);
			if (nextAgentId) await this.activateNavigationAgent(nextAgentId);
		}
		this.tui.requestRender();
	}

	private async activateNavigationAgent(agentId: string): Promise<void> {
		await this.syncAgent(agentId);
		if (!this.state.agents.has(agentId)) return;
		this.switchAgent(agentId);
	}

	private switchAgent(agentId: string): void {
		const previousAgentId = this.state.activeAgentId;
		if (previousAgentId) {
			this.drafts.set(previousAgentId, this.editor.getText());
		}
		const agent = setActiveAgent(this.state, agentId);
		this.editor.setText(this.drafts.get(agentId) ?? "");
		this.state.mode = "editor";
		this.updateEditorAvailability();
		this.refreshCommands(agentId);
		this.updateTerminalTitle();
		this.tui.setFocus(this.editor);
		this.tui.requestRender();
		if (
			!this.hydratedAgents.has(agentId) &&
			agent.status !== "unavailable" &&
			agent.hydration !== "pending"
		) {
			this.projector.beginHydration(agentId);
			this.schedule(() => this.hydrateAgent(agentId));
		}
	}

	private async syncAgent(agentId: string): Promise<void> {
		try {
			applyAgentSnapshot(this.state, this.orchestrator.inspectAgent(agentId));
		} catch {
			return;
		}
		this.updateEditorAvailability();
		this.tui.requestRender();
	}

	private async syncAllAgents(): Promise<readonly AgentRecordSnapshot[]> {
		const snapshots = this.orchestrator.listAgents().agents;
		for (const snapshot of snapshots) applyAgentSnapshot(this.state, snapshot);
		return snapshots;
	}

	private async hydrateAgent(agentId: string): Promise<void> {
		const generation = (this.hydrationGeneration.get(agentId) ?? 0) + 1;
		this.hydrationGeneration.set(agentId, generation);
		const agent = ensureAgentProjection(this.state, agentId);
		if (agent.hydration !== "pending") this.projector.beginHydration(agentId);
		try {
			const snapshot = await this.orchestrator.getAgentSession(agentId);
			const result = hydrateSessionEntries(snapshot.pathToRoot);
			const statuses = this.orchestrator.listExtensionStatuses(agentId);
			if (this.hydrationGeneration.get(agentId) !== generation) return;
			result.display.sessionName ??= snapshot.name;
			this.projector.completeHydration(agentId, result, statuses);
			this.hydratedAgents.add(agentId);
		} catch (error) {
			if (this.hydrationGeneration.get(agentId) !== generation) return;
			this.projector.failHydration(
				agentId,
				`Could not restore session history: ${errorMessage(error)}`,
			);
		}
		this.tui.requestRender();
	}

	private refreshCommands(agentId: string): void {
		const generation = (this.commandGeneration.get(agentId) ?? 0) + 1;
		this.commandGeneration.set(agentId, generation);
		queueMicrotask(() => {
			if (this.commandGeneration.get(agentId) !== generation) return;
			try {
				const commands = this.orchestrator.listCommands(agentId);
				const agent = ensureAgentProjection(this.state, agentId);
				agent.commands = commands;
				agent.commandRevision++;
				if (this.state.activeAgentId === agentId) {
					this.editor.setAutocompleteProvider(
						new WidiCommandAutocompleteProvider({
							commands,
							agentId,
							orchestrator: this.orchestrator,
							cwd: this.runtime.services.cwd,
						}),
					);
				}
			} catch (error) {
				this.addApplicationNotice(
					`Could not load commands: ${errorMessage(error)}`,
					agentId,
				);
			}
			this.tui.requestRender();
		});
	}

	private async recoverInitialSpawnFailure(error: unknown): Promise<void> {
		const snapshots = await this.syncAllAgents();
		const unavailable =
			[...snapshots]
				.reverse()
				.find((snapshot) => snapshot.status === "unavailable") ??
			snapshots.at(-1);
		if (unavailable) {
			setActiveAgent(this.state, unavailable.agentId);
			applyAgentSnapshot(this.state, unavailable);
		}
		if (error instanceof OrchestratorError) {
			this.projectDiagnostic(error.diagnostic);
		} else {
			this.addApplicationNotice(`Agent startup failed: ${errorMessage(error)}`);
		}
		this.updateEditorAvailability();
	}

	private projectDiagnostic(diagnostic: OrchestratorDiagnostic): void {
		this.projector.apply({
			type: "diagnostic",
			diagnostic,
			createdAt: new Date().toISOString(),
		});
	}

	private addStartupSummary(): void {
		const services = this.runtime.services;
		this.state.globalNotices.push({
			id: "startup:summary",
			kind: "startup",
			createdAt: new Date().toISOString(),
			text: `${services.defaultProfile.id} · ${services.defaultModel.provider}/${services.defaultModel.modelId} · thinking ${services.defaultThinkingLevel.level}`,
		});
	}

	private addApplicationNotice(text: string, agentId?: string): void {
		const createdAt = new Date().toISOString();
		if (agentId) {
			// Agent-scoped operation feedback belongs in that agent's transcript at
			// the moment it happened, not pinned above the chat.
			const agent = ensureAgentProjection(this.state, agentId);
			agent.timeline.push({
				type: "application-notice",
				id: `application-notice:${agentId}:${agent.nextLiveItemId++}`,
				durability: "ephemeral",
				createdAt,
				text,
			});
		} else {
			const id = `application:${createdAt}:${this.state.globalNotices.length}`;
			this.state.globalNotices.push({
				id,
				kind: "application",
				createdAt,
				text,
			});
			this.expireNotification(id);
		}
		this.tui.requestRender();
	}

	private expireNotification(id: string): void {
		const existing = this.notificationTimers.get(id);
		if (existing) clearTimeout(existing);
		const timer = setTimeout(() => {
			this.notificationTimers.delete(id);
			this.state.globalNotices = this.state.globalNotices.filter(
				(notice) => notice.id !== id,
			);
			this.tui.requestRender();
		}, NOTIFICATION_TTL_MS);
		timer.unref();
		this.notificationTimers.set(id, timer);
	}

	private interrupt(): void {
		if (this.agentSelector.isOpen) {
			this.agentSelector.close();
			return;
		}
		const agentId = this.state.activeAgentId;
		if (!agentId) return;
		const agent = ensureAgentProjection(this.state, agentId);
		if (agent.status === "running") {
			this.track(
				this.orchestrator.abortAgent(agentId).catch((error) => {
					this.addApplicationNotice(errorMessage(error), agentId);
				}),
			);
		}
	}

	private updateEditorAvailability(): void {
		const agentId = this.state.activeAgentId;
		const agent = agentId ? this.state.agents.get(agentId) : undefined;
		this.editor.disableSubmit =
			this.state.shuttingDown ||
			!agent ||
			agent.status === "unavailable" ||
			agent.status === "disposed" ||
			agent.snapshot?.hasHarness === false;
	}

	private restoreEditor(text: string, agentId?: string): void {
		if (!agentId) {
			if (!this.editor.getText().trim()) this.editor.setText(text);
			return;
		}
		const currentDraft = this.drafts.get(agentId);
		if (!currentDraft?.trim()) this.drafts.set(agentId, text);
		if (this.state.activeAgentId === agentId && !this.editor.getText().trim()) {
			this.editor.setText(this.drafts.get(agentId) ?? text);
		}
	}

	private resolveAgentLabel(agentId: string | undefined): string {
		if (!agentId) return "unknown";
		const projection = this.state.agents.get(agentId);
		if (projection) return agentLabel(projection);
		try {
			const snapshot = this.orchestrator.inspectAgent(agentId);
			applyAgentSnapshot(this.state, snapshot);
			return (
				snapshot.profile.reference.label ??
				snapshot.profile.reference.id ??
				agentId
			);
		} catch {
			return agentId;
		}
	}

	private updateTerminalTitle(): void {
		const agentId = this.state.activeAgentId;
		const agent = agentId ? this.state.agents.get(agentId) : undefined;
		this.tui.terminal.setTitle(agent ? `WIDI - ${agentLabel(agent)}` : "WIDI");
	}

	private schedule(task: () => void | Promise<void>): void {
		queueMicrotask(() => {
			try {
				const result = task();
				if (result instanceof Promise) this.track(result);
			} catch (error) {
				this.addApplicationNotice(errorMessage(error));
			}
		});
	}

	private track<T>(promise: Promise<T>): Promise<T> {
		this.pendingTasks.add(promise);
		void promise.then(
			() => this.pendingTasks.delete(promise),
			(error) => {
				this.pendingTasks.delete(promise);
				if (!this.state.shuttingDown) {
					this.addApplicationNotice(errorMessage(error));
				}
			},
		);
		return promise;
	}

	private trackLifecycle<T>(promise: Promise<T>): Promise<T> {
		this.lifecycleTasks.add(promise);
		void promise.then(
			() => this.lifecycleTasks.delete(promise),
			() => this.lifecycleTasks.delete(promise),
		);
		return promise;
	}

	private installLifecycleHandlers(): void {
		process.once("SIGTERM", this.onSigterm);
		process.once("SIGINT", this.onSigint);
	}

	private removeLifecycleHandlers(): void {
		process.off("SIGTERM", this.onSigterm);
		process.off("SIGINT", this.onSigint);
	}
}

export async function runWidiTui(options: WidiTuiOptions): Promise<void> {
	const application = await WidiTuiApplication.create(options);
	await application.run();
}

function navigationAgentId(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || !("agentId" in value)) {
		return undefined;
	}
	return typeof value.agentId === "string" ? value.agentId : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
