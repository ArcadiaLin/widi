/** The smallest element helper that keeps the rest of the viewer readable. */

type Child = Node | string | number | null | undefined | false;

export interface ElementOptions {
	readonly class?: string;
	readonly text?: string;
	readonly title?: string;
	readonly html?: string;
	readonly attrs?: Record<string, string | number | boolean | undefined>;
	readonly on?: Record<string, (event: Event) => void>;
	readonly style?: Record<string, string>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	options: ElementOptions = {},
	children: readonly Child[] = [],
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (options.class !== undefined) node.className = options.class;
	if (options.text !== undefined) node.textContent = options.text;
	if (options.html !== undefined) node.innerHTML = options.html;
	if (options.title !== undefined) node.title = options.title;
	for (const [name, value] of Object.entries(options.attrs ?? {})) {
		if (value === undefined || value === false) continue;
		node.setAttribute(name, value === true ? "" : String(value));
	}
	for (const [name, handler] of Object.entries(options.on ?? {})) {
		node.addEventListener(name, handler);
	}
	for (const [name, value] of Object.entries(options.style ?? {})) {
		node.style.setProperty(name, value);
	}
	append(node, children);
	return node;
}

export function svg(
	tag: string,
	attrs: Record<string, string | number> = {},
	children: readonly Node[] = [],
): SVGElement {
	const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
	for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
	for (const child of children) node.appendChild(child);
	return node;
}

export function append(parent: Node, children: readonly Child[]): void {
	for (const child of children) {
		if (child === null || child === undefined || child === false) continue;
		parent.appendChild(
			typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child,
		);
	}
}

export function clear(node: Node): void {
	while (node.firstChild) node.removeChild(node.firstChild);
}

export function replace(node: Node, children: readonly Child[]): void {
	clear(node);
	append(node, children);
}
