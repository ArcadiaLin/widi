/**
 * The drawing surface a `tui` half needs to paint with.
 *
 * `setWidget` and `showOverlay` take a `Component`, and anything that renders
 * one has to measure, wrap and truncate text and match keys against the
 * configurable table. Those all live in pi-tui - which an extension directory
 * cannot import by name: it has no `node_modules` of its own, and extensions
 * reach the application through relative paths into this source tree. Without
 * this module the component-class half of the API is declared but unreachable.
 *
 * A leaf on purpose. It imports nothing of the application, so an extension that
 * only wants to paint does not pull the host and its graph in behind it.
 */
export {
	type Component,
	getKeybindings,
	type KeyId,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
