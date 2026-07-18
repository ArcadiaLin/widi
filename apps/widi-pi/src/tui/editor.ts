import { Editor, getKeybindings } from "@earendil-works/pi-tui";

export class WidiEditor extends Editor {
	onOpenAgents?: () => void;
	onInterrupt?: () => void;
	onExit?: () => void;
	onToggleToolOutput?: () => void;
	onSteer?: () => void;
	onOpenRequests?: () => void;

	override handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "app.tools.expand")) {
			this.onToggleToolOutput?.();
			return;
		}
		if (keybindings.matches(data, "app.steer")) {
			this.onSteer?.();
			return;
		}
		if (keybindings.matches(data, "app.request.open")) {
			this.onOpenRequests?.();
			return;
		}
		if (
			keybindings.matches(data, "app.agents.open") &&
			this.getText().length === 0 &&
			!this.isShowingAutocomplete()
		) {
			this.onOpenAgents?.();
			return;
		}
		if (keybindings.matches(data, "app.interrupt")) {
			if (this.isShowingAutocomplete()) {
				super.handleInput(data);
			} else {
				this.onInterrupt?.();
			}
			return;
		}
		if (keybindings.matches(data, "app.exit") && this.getText().length === 0) {
			this.onExit?.();
			return;
		}
		super.handleInput(data);
	}
}
