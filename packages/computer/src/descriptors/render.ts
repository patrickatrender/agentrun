// Render's descriptor: a sandbox (a Firecracker microVM), no mount yet, network none.
import { defineProvider } from "../descriptor.js";
import { SANDBOX } from "./shared.js";

/** Render's own base image: a sandbox when its setting names no image (no snapshot and no build). */
export const RENDER_DEFAULT_IMAGE = "default";

export const RENDER = defineProvider({
	id: "render",
	label: "Render",
	keys: [
		{ name: "RENDER_API_KEY", option: "apiKey", required: true },
		// The workspace (owner) every sandbox is made in and listed from: Render's list needs it (tea-... or usr-...).
		{ name: "RENDER_WORKSPACE_ID", option: "ownerId", required: true },
	],
	metered: true,
	// None yet: whether a Render sandbox gives /dev/fuse, which an Archil mount needs, is not proven.
	mounts: [],
	// None: its programs run in a network of their own (isolation.ts OWN_NETWORK_ONLY), in a sandbox Render denies all egress.
	network: ["none"],
	capabilities: [SANDBOX],
	defaultImage: { sandbox: RENDER_DEFAULT_IMAGE },
	load: () => import("../render.js"),
});
