import { homedir } from "node:os";
import { join } from "node:path";
import { ProcessTerminal, setKeybindings, TUI } from "@earendil-works/pi-tui";
import type {
	AgentOrchestrator,
	OrchestratorEvent,
} from "../core/agent-orchestrator.ts";
import {
	type OrchestratorDiagnostic,
	OrchestratorError,
} from "../core/diagnostics.ts";
import {
	createWidiRuntime,
	type WidiRuntime,
} from "../core/runtime-service.ts";
import type { CandidateItem, PromptExpansion } from "../core/types.ts";
import { AgentSelectorController } from "./agent-selector.ts";
import { WidiCommandAutocompleteProvider } from "./autocomplete.ts";
import { applicationCommands } from "./commands/app-commands.ts";
import { builtInCommands } from "./commands/built-ins.ts";
import { CommandEngine, switchedAgentId } from "./commands/engine.ts";
import { parseLineCommand } from "./commands/parse.ts";
import type {
	CommandError,
	EngineOutcome,
	LineCommand,
} from "./commands/types.ts";
import { CompletionMenu } from "./completion-menu.ts";
import { AgentStripView } from "./components/agent-strip.ts";
import { ChatView } from "./components/chat.ts";
import { agentLabel } from "./components/common.ts";
import { FatalErrorView } from "./components/fatal-error.ts";
import { FooterView } from "./components/footer.ts";
import { HeaderView } from "./components/header.ts";
import { NoticeView } from "./components/notices.ts";
import { ProcessingBarView } from "./components/processing-bar.ts";
import { QueuedInputView } from "./components/queued-input.ts";
import { StatusView } from "./components/status.ts";
import { WidiEditor } from "./editor.ts";
import { applyAgentSnapshot, EventProjector } from "./event-projector.ts";
import { singleLine } from "./format.ts";
import { HumanRequestMenu } from "./human-request.ts";
import { createWidiKeybindings } from "./keybindings.ts";
import {
	PendingAgentController,
	type PendingAgentDisplay,
} from "./pending-agent.ts";
import { hydrateSessionEntries } from "./session-hydrator.ts";
import {
	createTuiApplicationState,
	ensureAgentProjection,
	setActiveAgent,
	type TuiApplicationState,
} from "./state.ts";
import { editorTheme } from "./theme/controls.ts";

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
	private readonly completionMenu: CompletionMenu;
	private readonly humanRequests: HumanRequestMenu;
	private readonly agentSelector: AgentSelectorController;
	private readonly pendingAgents: PendingAgentController;
	/** Unknown "/" input awaiting a confirming second enter (v2 §11.2). */
	private pendingUnknownCommand?: { scopeId: string; text: string };
	private readonly engine = new CommandEngine([
		...builtInCommands,
		...applicationCommands({
			quit: () => {
				void this.shutdown("user exit").catch(() => {});
			},
			newSession: (sourceAgentId) => this.beginNewSession(sourceAgentId),
		}),
	]);
	private unsubscribeEvents?: () => void;
	private unregisterClient?: () => void;
	private readonly hydrationGeneration = new Map<string, number>();
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
	private fatalOverlayShown = false;
	private readonly onUncaughtError = (error: unknown) => {
		// The fatal application-error boundary (v2 §13.1): state may be corrupt,
		// so the modal overlay only offers Quit or read-only diagnostics. If the
		// overlay itself cannot be shown, fall back to stderr instead of dying
		// inside the uncaught-error handler.
		try {
			this.showFatalOverlay(
				"application.unexpected_error",
				errorMessage(error),
			);
		} catch {
			try {
				process.stderr.write(
					`Fatal application error: ${errorMessage(error)}\n`,
				);
			} catch {
				// Nothing left to report through.
			}
		}
	};

	private constructor(runtime: WidiRuntime) {
		this.runtime = runtime;
		this.orchestrator = runtime.orchestrator;
		this.state = createTuiApplicationState();
		this.projector = new EventProjector(this.state);
		this.pendingAgents = new PendingAgentController(
			this.state,
			this.orchestrator,
			this.defaultPendingDisplay(),
		);

		const keybindings = createWidiKeybindings();
		setKeybindings(keybindings);
		this.tui = new TUI(new ProcessTerminal());
		this.editor = new WidiEditor(this.tui, editorTheme, {
			paddingX: 1,
			autocompleteMaxVisible: 8,
		});
		// Later-opened menus own the focus; closing one hands focus back to the
		// still-open human-request menu before falling back to the editor.
		this.completionMenu = new CompletionMenu(this.tui, this.state, () => {
			this.tui.setFocus(
				this.humanRequests.isOpen ? this.humanRequests : this.editor,
			);
		});
		this.humanRequests = new HumanRequestMenu({
			host: this.tui,
			state: this.state,
			resolveAgentLabel: (agentId) => this.resolveAgentLabel(agentId),
			restoreFocus: () => this.tui.setFocus(this.editor),
		});
		this.agentSelector = new AgentSelectorController(
			this.completionMenu,
			this.state,
			(agentId) => this.switchAgent(agentId),
		);

		this.tui.addChild(new HeaderView(this.state));
		this.tui.addChild(new ProcessingBarView(this.state));
		this.tui.addChild(new NoticeView(this.state));
		this.tui.addChild(new ChatView(this.state));
		this.tui.addChild(new StatusView(this.state));
		this.tui.addChild(new QueuedInputView(this.state));
		this.tui.addChild(this.humanRequests);
		this.tui.addChild(this.completionMenu);
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
			else if (this.state.pendingAgent) this.state.pendingAgent.draft = text;
		};
		this.editor.onOpenAgents = () => this.agentSelector.open();
		this.editor.onToggleToolOutput = () => {
			this.state.toolOutputExpanded = !this.state.toolOutputExpanded;
			this.tui.requestRender();
		};
		this.editor.onInterrupt = () => this.interrupt();
		this.editor.onSteer = () => this.steerFromEditor();
		this.editor.onOpenRequests = () => this.humanRequests.openLatest();
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
		let animationTick = 0;
		this.animationTimer = setInterval(() => {
			animationTick++;
			const agentId = this.state.activeAgentId;
			const agent = agentId ? this.state.agents.get(agentId) : undefined;
			if (!agent) return;
			const spinning =
				agent.status === "running" ||
				[...agent.extensionStatuses.values()].some(
					(entry) =>
						entry.status.progress !== undefined &&
						entry.status.progress.total === undefined,
				);
			// Status ages only need a slow tick; spinners animate every frame.
			const agingStatuses =
				animationTick % 6 === 0 && agent.extensionStatuses.size > 0;
			if (spinning || agingStatuses) this.tui.requestRender();
		}, 160);
		this.animationTimer.unref();
		this.tui.terminal.setTitle("WIDI");
		// Routine resolution facts collapse to one startup line; only actual
		// problems occupy the persistent notice area.
		for (const diagnostic of this.runtime.diagnostics) {
			if (diagnostic.severity !== "info") this.projectDiagnostic(diagnostic);
		}
		this.addStartupSummary();
		this.configurePendingEditor();
		this.updateEditorAvailability();
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
				break;
			case "agent_status_changed":
				this.schedule(() => this.syncAgent(event.agentId));
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
			case "auth_login_url":
				this.addApplicationNotice(
					event.instructions
						? `Login: open ${event.url} — ${event.instructions}`
						: `Login: open ${event.url}`,
					event.agentId,
				);
				break;
			case "auth_login_code":
				this.addApplicationNotice(
					`Login: open ${event.verificationUri} and enter code ${event.userCode}`,
					event.agentId,
				);
				break;
			case "auth_login_progress":
				this.addApplicationNotice(`Login: ${event.message}`, event.agentId);
				break;
			case "human_request_timeout":
			case "human_request_cancelled":
				this.humanRequests.cancelRequest(event.requestId);
				break;
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

		// Unknown "/name" input never reaches the model on the first enter: a
		// local notice asks for a confirming second submit (v2 §11.2).
		const parsed = parseLineCommand(text);
		const matchedCommand = parsed ? this.engine.match(text) : undefined;
		const initialAgentId = this.state.activeAgentId;
		const scopeId = initialAgentId ?? "pending";
		if (parsed && !matchedCommand) {
			const pending = this.pendingUnknownCommand;
			if (pending?.scopeId !== scopeId || pending.text !== text) {
				this.pendingUnknownCommand = { scopeId, text };
				this.restoreEditor(rawText, initialAgentId);
				this.addApplicationNotice(
					`Unknown command /${parsed.name}. Press enter again to send it as a prompt.`,
					initialAgentId,
				);
				return;
			}
		}
		this.pendingUnknownCommand = undefined;

		let agentId = initialAgentId;
		const materializesPendingAgent =
			!agentId &&
			(!parsed ||
				!matchedCommand ||
				(matchedCommand.agentPolicy === "materialize" &&
					parsed.argument.trim() !== ""));
		if (materializesPendingAgent) {
			agentId = await this.materializePendingAgent(rawText);
			if (!agentId) return;
		}

		const agent = agentId
			? ensureAgentProjection(this.state, agentId)
			: undefined;
		if (
			agent &&
			(agent.status === "unavailable" ||
				agent.status === "disposed" ||
				!agent.snapshot?.hasHarness)
		) {
			this.restoreEditor(rawText, agentId);
			this.addApplicationNotice(
				`Agent ${agentLabel(agent)} cannot accept input (${agent.status}).`,
				agentId,
			);
			return;
		}

		let outcome: EngineOutcome;
		const startedCommands: Array<{
			commandId: string;
			argument: string;
		}> = [];
		try {
			outcome = await this.engine.handleInput(
				text,
				{
					agentId,
					orchestrator: this.orchestrator,
					pendingModel: this.state.pendingAgent?.display.model,
				},
				{
					onCommandStart: (commandId, name, argument) => {
						startedCommands.push({ commandId, argument });
						this.upsertCommandItem(agentId, commandId, {
							name,
							argument,
							status: "running",
						});
						this.tui.requestRender();
					},
				},
			);
		} catch (error) {
			this.removeCommandItems(
				agentId,
				startedCommands.map((started) => started.commandId),
			);
			this.restoreEditor(rawText, agentId);
			this.addApplicationNotice(errorMessage(error), agentId);
			return;
		}

		switch (outcome.kind) {
			case "pass":
				if (!agentId || !agent) {
					this.restoreEditor(rawText, agentId);
					this.addApplicationNotice("No active agent is available.");
					return;
				}
				if (agent.status === "running") {
					await this.submitFollowUp(agentId, rawText, text);
					return;
				}
				await this.submitPrompt(agentId, rawText, text, undefined);
				return;
			case "expanded":
				this.removeCommandItems(
					agentId,
					startedCommands.map((started) => started.commandId),
				);
				if (!agentId || !agent) {
					this.restoreEditor(rawText, agentId);
					this.addApplicationNotice("No active agent is available.");
					return;
				}
				if (agent.status === "running") {
					await this.submitFollowUp(agentId, rawText, outcome.text);
					return;
				}
				await this.submitPrompt(
					agentId,
					rawText,
					outcome.text,
					outcome.expansion,
				);
				return;
			case "executed": {
				this.editor.addToHistory(rawText);
				this.upsertCommandItem(agentId, outcome.commandId, {
					name: outcome.name,
					status: "completed",
					result: outcome.value,
				});
				const nextAgentId = switchedAgentId(outcome);
				if (nextAgentId) await this.activateNavigationAgent(nextAgentId);
				this.tui.requestRender();
				return;
			}
			case "failed": {
				const failedStart = startedCommands.find(
					(started) => started.commandId === outcome.commandId,
				);
				this.removeCommandItems(
					agentId,
					startedCommands
						.filter((started) => started.commandId !== outcome.commandId)
						.map((started) => started.commandId),
				);
				this.editor.addToHistory(rawText);
				this.upsertCommandItem(agentId, outcome.commandId, {
					name: outcome.name,
					argument: failedStart?.argument ?? parseLineCommand(text)?.argument,
					status: "failed",
					error: outcome.error,
				});
				this.tui.requestRender();
				return;
			}
			case "needs-argument":
				this.openCommandCompletionMenu(
					agentId,
					rawText,
					outcome.command,
					outcome.candidates,
				);
				return;
		}
	}

	private async materializePendingAgent(
		rawText: string,
	): Promise<string | undefined> {
		// Do not let a second submit replace the pending intent while core is
		// creating the session that the first submit requested.
		this.editor.disableSubmit = true;
		this.tui.requestRender();
		try {
			const agentId = await this.trackLifecycle(
				this.pendingAgents.materialize(),
			);
			if (this.state.shuttingDown) return undefined;
			applyAgentSnapshot(this.state, this.orchestrator.inspectAgent(agentId));
			this.drafts.set(agentId, "");
			this.switchAgent(agentId);
			return agentId;
		} catch (error) {
			this.restoreEditor(rawText);
			if (error instanceof OrchestratorError) {
				this.projectDiagnostic(error.diagnostic);
			} else {
				this.addApplicationNotice(
					`Agent startup failed: ${errorMessage(error)}`,
				);
			}
			this.configurePendingEditor();
			this.updateEditorAvailability();
			this.tui.requestRender();
			return undefined;
		}
	}

	private async submitPrompt(
		agentId: string,
		rawText: string,
		text: string,
		expansion: PromptExpansion | undefined,
	): Promise<void> {
		const agent = ensureAgentProjection(this.state, agentId);
		agent.pendingInput = {
			originalText: rawText,
			submittedAt: new Date().toISOString(),
		};
		this.editor.addToHistory(rawText);
		this.tui.requestRender();
		try {
			const outcome = await this.orchestrator.promptAgent(agentId, text, {
				expansion,
			});
			if (outcome.kind === "blocked") {
				agent.pendingInput = undefined;
				this.restoreEditor(rawText, agentId);
				this.addApplicationNotice(
					outcome.reason
						? `Input blocked by ${outcome.blockedBy}: ${outcome.reason}`
						: `Input blocked by ${outcome.blockedBy}.`,
					agentId,
				);
			}
		} catch (error) {
			const pending = ensureAgentProjection(this.state, agentId).pendingInput;
			ensureAgentProjection(this.state, agentId).pendingInput = undefined;
			if (pending) this.restoreEditor(rawText, agentId);
			if (error instanceof OrchestratorError) {
				this.projectDiagnostic(error.diagnostic);
			} else {
				this.addApplicationNotice(errorMessage(error), agentId);
			}
		}
		this.tui.requestRender();
	}

	/**
	 * Default running-agent path (v2 §11.2): plain text joins the core followUp
	 * queue and is consumed automatically when the run ends. The queued texts
	 * come back through queue_update and feed the QueuedInputView.
	 */
	private async submitFollowUp(
		agentId: string,
		rawText: string,
		text: string,
	): Promise<void> {
		this.editor.addToHistory(rawText);
		try {
			await this.orchestrator.followUpAgent(agentId, text);
		} catch (error) {
			this.restoreEditor(rawText, agentId);
			if (error instanceof OrchestratorError) {
				this.projectDiagnostic(error.diagnostic);
			} else {
				this.addApplicationNotice(errorMessage(error), agentId);
			}
		}
		this.tui.requestRender();
	}

	/** app.steer: send the editor text as an immediate steer instead of queueing. */
	private steerFromEditor(): void {
		if (this.state.shuttingDown) return;
		const agentId = this.state.activeAgentId;
		if (!agentId) return;
		const agent = ensureAgentProjection(this.state, agentId);
		if (agent.status !== "running") {
			this.addApplicationNotice("Steer needs a running agent.", agentId);
			return;
		}
		const text = this.editor.getText().trim();
		if (!text) {
			this.addApplicationNotice(
				"Type a message to steer the running agent.",
				agentId,
			);
			return;
		}
		this.editor.setText("");
		this.drafts.set(agentId, "");
		this.editor.addToHistory(text);
		this.track(
			this.orchestrator.steerAgent(agentId, text).catch((error) => {
				this.restoreEditor(text, agentId);
				this.addApplicationNotice(errorMessage(error), agentId);
			}),
		);
		this.tui.requestRender();
	}

	private upsertCommandItem(
		agentId: string | undefined,
		commandId: string,
		update: {
			name: string;
			argument?: string;
			status: "running" | "completed" | "failed";
			result?: unknown;
			error?: CommandError;
		},
	): void {
		const timeline = agentId
			? ensureAgentProjection(this.state, agentId).timeline
			: this.state.pendingAgent?.timeline;
		if (!timeline) return;
		const existing = timeline.find(
			(item) => item.type === "command-result" && item.commandId === commandId,
		);
		if (existing?.type === "command-result") {
			existing.status = update.status;
			existing.result = update.result;
			existing.error = update.error;
			return;
		}
		timeline.push({
			type: "command-result",
			id: commandId,
			commandId,
			durability: "ephemeral",
			createdAt: new Date().toISOString(),
			name: update.name,
			argument: update.argument ?? "",
			status: update.status,
			result: update.result,
			error: update.error,
		});
	}

	private removeCommandItems(
		agentId: string | undefined,
		commandIds: readonly string[],
	): void {
		if (commandIds.length === 0) return;
		const ids = new Set(commandIds);
		if (agentId) {
			const agent = ensureAgentProjection(this.state, agentId);
			agent.timeline = agent.timeline.filter(
				(item) => item.type !== "command-result" || !ids.has(item.commandId),
			);
		} else if (this.state.pendingAgent) {
			this.state.pendingAgent.timeline =
				this.state.pendingAgent.timeline.filter(
					(item) => item.type !== "command-result" || !ids.has(item.commandId),
				);
		}
	}

	private openCommandCompletionMenu(
		agentId: string | undefined,
		originalText: string,
		command: LineCommand,
		candidates: readonly CandidateItem[],
	): void {
		if (candidates.length === 0 && !command.complete) {
			// Nothing to pick from: an empty menu is a dead end, a usage line is not.
			this.restoreEditor(originalText, agentId);
			this.addApplicationNotice(
				`Command /${command.name} needs an argument: /${command.name}:${
					command.argumentHint ?? "<argument>"
				}`,
				agentId,
			);
			return;
		}
		const items = candidates.map((candidate) => ({
			value: candidate.value,
			label: candidate.label ?? candidate.value,
			description: candidate.description,
		}));
		if (command.name === "fork") {
			items.unshift({
				value: "",
				label: "Fork here (current position)",
				description: "Use the current session position",
			});
		}
		this.completionMenu.open({
			title: `/${command.name}`,
			items,
			onSelect: (item) => {
				this.track(this.submit(`/${command.name}:${item.value}`));
			},
			onCancel: () => this.restoreEditor(originalText, agentId),
		});
	}

	private async activateNavigationAgent(agentId: string): Promise<void> {
		await this.syncAgent(agentId);
		if (!this.state.agents.has(agentId)) return;
		this.switchAgent(agentId);
	}

	private beginNewSession(sourceAgentId: string | undefined): void {
		const previousAgentId = this.state.activeAgentId;
		if (previousAgentId) {
			this.drafts.set(previousAgentId, this.editor.getText());
		}
		if (sourceAgentId) {
			this.pendingAgents.beginNewSession(
				sourceAgentId,
				this.pendingDisplayForSource(sourceAgentId),
			);
		} else {
			this.pendingAgents.beginDefault(this.defaultPendingDisplay());
		}
		this.pendingUnknownCommand = undefined;
		this.editor.setText("");
		this.configurePendingEditor();
		this.updateTerminalTitle();
		this.updateEditorAvailability();
		this.tui.setFocus(this.editor);
		this.tui.requestRender();
	}

	private defaultPendingDisplay(): PendingAgentDisplay {
		return {
			profileLabel: this.runtime.services.defaultProfile.id,
			model: this.orchestrator.getDefaultModel(),
			thinkingLevel: this.orchestrator.getDefaultThinkingLevel(),
		};
	}

	private pendingDisplayForSource(sourceAgentId: string): PendingAgentDisplay {
		const projection = this.state.agents.get(sourceAgentId);
		let snapshot = projection?.snapshot;
		if (!snapshot) {
			try {
				snapshot = this.orchestrator.inspectAgent(sourceAgentId);
			} catch {
				return this.defaultPendingDisplay();
			}
		}
		return {
			profileLabel:
				snapshot.profile.reference.label ??
				snapshot.profile.reference.id ??
				sourceAgentId,
			model: projection?.display.model ?? snapshot.model,
			thinkingLevel: this.orchestrator.getDefaultThinkingLevel(),
		};
	}

	private configurePendingEditor(): void {
		this.editor.setAutocompleteProvider(
			new WidiCommandAutocompleteProvider({
				engine: this.engine,
				orchestrator: this.orchestrator,
				getStatus: () => undefined,
				getPendingModel: () => this.state.pendingAgent?.display.model,
				cwd: this.runtime.services.cwd,
			}),
		);
	}

	private switchAgent(agentId: string): void {
		const previousAgentId = this.state.activeAgentId;
		if (previousAgentId) {
			this.drafts.set(previousAgentId, this.editor.getText());
		}
		this.pendingAgents.cancel();
		const agent = setActiveAgent(this.state, agentId);
		this.editor.setText(this.drafts.get(agentId) ?? "");
		this.state.mode = "editor";
		this.updateEditorAvailability();
		this.editor.setAutocompleteProvider(
			new WidiCommandAutocompleteProvider({
				engine: this.engine,
				agentId,
				orchestrator: this.orchestrator,
				getStatus: () => this.state.agents.get(agentId)?.status ?? "idle",
				cwd: this.runtime.services.cwd,
			}),
		);
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

	/**
	 * Overlay is reserved for failures the application cannot continue from:
	 * an uncaught fatal error (v2 §13.1).
	 */
	private showFatalOverlay(code: string, message: string): void {
		if (this.state.shuttingDown || this.fatalOverlayShown) return;
		this.fatalOverlayShown = true;
		const view = new FatalErrorView({
			code,
			message,
			onQuit: () => {
				void this.shutdown("fatal error").catch(() => {});
			},
			onViewDiagnostics: () => {
				this.fatalOverlayShown = false;
				overlay.hide();
				this.tui.setFocus(this.editor);
				this.tui.requestRender();
			},
		});
		const overlay = this.tui.showOverlay(view, {
			width: "70%",
			minWidth: 36,
			maxHeight: "70%",
			anchor: "center",
			margin: 1,
		});
	}

	private projectDiagnostic(diagnostic: OrchestratorDiagnostic): void {
		this.projector.apply({
			type: "diagnostic",
			diagnostic,
			createdAt: new Date().toISOString(),
		});
	}

	private addStartupSummary(): void {
		// The one-line summary merges the real info-level diagnostics; the
		// synthetic services line is only a fallback when none were reported.
		const infoEntries = this.runtime.diagnostics.filter(
			(diagnostic) => diagnostic.severity === "info",
		);
		const services = this.runtime.services;
		const text =
			infoEntries.length > 0
				? infoEntries
						.map((diagnostic) => singleLine(diagnostic.message, 200))
						.join(" · ")
				: `${services.defaultProfile.id} · ${services.defaultModel.provider}/${services.defaultModel.modelId} · thinking ${services.defaultThinkingLevel.level}`;
		this.state.globalNotices.push({
			id: "startup:summary",
			kind: "startup",
			createdAt: new Date().toISOString(),
			text,
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
		if (this.completionMenu.isOpen) {
			this.completionMenu.close();
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
			(!this.state.pendingAgent &&
				(!agent ||
					agent.status === "unavailable" ||
					agent.status === "disposed" ||
					agent.snapshot?.hasHarness === false));
	}

	private restoreEditor(text: string, agentId?: string): void {
		if (!agentId) {
			if (this.state.pendingAgent && !this.state.pendingAgent.draft.trim()) {
				this.state.pendingAgent.draft = text;
			}
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
		process.on("uncaughtException", this.onUncaughtError);
		process.on("unhandledRejection", this.onUncaughtError);
	}

	private removeLifecycleHandlers(): void {
		process.off("SIGTERM", this.onSigterm);
		process.off("SIGINT", this.onSigint);
		process.off("uncaughtException", this.onUncaughtError);
		process.off("unhandledRejection", this.onUncaughtError);
	}
}

export async function runWidiTui(options: WidiTuiOptions): Promise<void> {
	const application = await WidiTuiApplication.create(options);
	await application.run();
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
