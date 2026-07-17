import { type Component, Text } from "@earendil-works/pi-tui";
import { singleLine } from "../format.ts";
import type { TuiApplicationState } from "../state.ts";
import { colors } from "../theme/colors.ts";
import { activeAgent, agentLabel } from "./common.ts";

export class HeaderView implements Component {
	private readonly state: TuiApplicationState;

	constructor(state: TuiApplicationState) {
		this.state = state;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const agent = activeAgent(this.state);
		const label = agent ? agentLabel(agent) : "starting";
		const model =
			agent?.display.model?.id ?? agent?.snapshot?.model.id ?? "model";
		return new Text(
			`${colors.bold(colors.accent("WIDI"))} ${colors.dim(
				`· ${label} · ${singleLine(model, 120)}`,
			)}`,
			1,
			1,
		).render(width);
	}
}
