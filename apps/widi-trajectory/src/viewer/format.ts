/** Number and time formatting shared by every pane. */

export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "—";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatCount(value: number): string {
	if (!Number.isFinite(value)) return "—";
	if (Math.abs(value) < 1000) return String(Math.round(value));
	if (Math.abs(value) < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

export function formatCost(value: number): string {
	if (!Number.isFinite(value) || value === 0) return "$0";
	if (value < 0.01) return `$${value.toFixed(4)}`;
	return `$${value.toFixed(2)}`;
}

export function formatClock(at: number): string {
	if (!Number.isFinite(at) || at <= 0) return "—";
	const date = new Date(at);
	const pad = (value: number, size = 2): string => String(value).padStart(size, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

export function formatDateTime(at: number): string {
	if (!Number.isFinite(at) || at <= 0) return "—";
	const date = new Date(at);
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatOffset(ms: number): string {
	if (!Number.isFinite(ms)) return "—";
	const sign = ms < 0 ? "-" : "+";
	return `${sign}${formatDuration(Math.abs(ms))}`;
}
