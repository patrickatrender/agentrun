// Render for the conformance CLI: `npm run conformance -w @parcha/agentrun-computer -- --provider render [--image <image>]`.
// It makes real sandboxes, so it runs only with AGENTRUN_COMPUTER_LIVE_RENDER=1 and a key the lead has OKed, under
// COMPUTER_RENDER_API_KEY, in the workspace COMPUTER_RENDER_WORKSPACE_ID. The provider reads no environment: this
// module reads its own COMPUTER_RENDER_* names (never RENDER_API_KEY, which may hold another team's key) and passes each
// to create() as its option. The live switch is checked first, before any other setting is read. The live sweep
// (sweep.ts, --provider render) reads the same names through createHost, which needs no live switch: it makes nothing.
//
// The daemon is uploaded into each sandbox (dist/computerd-linux-amd64, `npm run build:daemon`), so a run publishes
// nothing. The drifted provider uploads a daemon built with Go as version <version>-drift. Every computer of a run lives
// at most 30 minutes. Until Render serves exec sessions (runs/session) to the workspace, every create fails
// unsupported, in words.
import type { MachineHost } from "../host.js";
import type { MountKind } from "../mount.js";
import { create, DEFAULT_API_URL, type RenderOptions, type RenderProvider } from "../render.js";
import { RENDER_DEFAULT_IMAGE } from "../descriptors/render.js";
import { buildDriftDaemon, DRIFT_VERSION } from "./drift-daemon.js";
import type { RunFolder } from "./types.js";

/** The environment this module reads, by name, each for the option its comment names, the live switch and the run's image. */
export const RENDER_ENV = {
	live: "AGENTRUN_COMPUTER_LIVE_RENDER",
	/** The image every computer of the run starts from; default "default", Render's base. */
	image: "COMPUTER_RENDER_IMAGE",
	/** apiKey, required: the Render API key. */
	key: "COMPUTER_RENDER_API_KEY",
	/** ownerId, required: the workspace (tea-...) sandboxes are made in. */
	workspace: "COMPUTER_RENDER_WORKSPACE_ID",
	/** apiUrl: Render's API; default https://api.render.com/v1. */
	apiUrl: "COMPUTER_RENDER_API_URL",
	/** daemonPath: the daemon binary; default this package's dist/computerd-linux-amd64. */
	daemon: "COMPUTER_RENDER_DAEMON",
	/** daemonUser: uid:gid the daemon runs as; default 2510:2510. */
	user: "COMPUTER_RENDER_USER",
} as const;

/** The names this module reads, under the conformance modules' common name (ConformanceModule.ENV). */
export const ENV = RENDER_ENV;

export type RenderSettings = Pick<RenderOptions, "apiKey" | "ownerId" | "apiUrl" | "daemonPath" | "daemonUser">;

/** The provider's options this module reads from env, each only when its name is set; throws in words without the key or workspace, never echoing a key. */
export function settingsFromEnv(env: Record<string, string | undefined> = process.env): RenderSettings {
	const apiKey = env[RENDER_ENV.key];
	if (apiKey === undefined || apiKey === "") throw new Error(`set ${RENDER_ENV.key} to a Render API key: the conformance module reads it there and nowhere else, never from RENDER_API_KEY`);
	const ownerId = env[RENDER_ENV.workspace];
	if (ownerId === undefined || ownerId === "") throw new Error(`set ${RENDER_ENV.workspace} to the Render workspace (tea-...) sandboxes are made in`);
	const apiUrl = env[RENDER_ENV.apiUrl] || undefined;
	const daemonPath = env[RENDER_ENV.daemon] || undefined;
	const daemonUser = env[RENDER_ENV.user] || undefined;
	return {
		apiKey,
		ownerId,
		...(apiUrl === undefined ? {} : { apiUrl }),
		...(daemonPath === undefined ? {} : { daemonPath }),
		...(daemonUser === undefined ? {} : { daemonUser }),
	};
}

/** The longest lifetime a computer of a run may ask for. */
export const CONFORMANCE_MAX_LIFETIME_MS = 30 * 60_000;

/** For the run's report: what this configuration means for the suite. */
export const conformanceNotes: string[] = [
	`render: Render sandboxes (${DEFAULT_API_URL}): timeoutSeconds is the lifetime, capped at 30 minutes for the run, and no extend (Render moves no timeout); network none is networkPolicy deny-all, read back from Render and probed from inside; no mount; no stream(), so screen.stream is skipped.`,
];

export interface RenderModuleOptions extends Pick<RenderOptions, "fetch" | "webSocket" | "daemonPath" | "timeouts" | "onNote"> {
	/** Where the settings are read; default process.env. */
	env?: Record<string, string | undefined>;
	/** Builds this package's daemon for linux/amd64 stamped with version, and gives its path; default go build. */
	buildDaemon?: (version: string) => Promise<string>;
}

function live(env: Record<string, string | undefined>): void {
	if (env[RENDER_ENV.live] !== "1") {
		throw new Error(`the Render conformance module makes real sandboxes: set ${RENDER_ENV.live}=1, with a key the lead has OKed, to run it`);
	}
}

/** The image every computer of the run starts from: COMPUTER_RENDER_IMAGE, or Render's base. */
export function conformanceImage({ env = process.env }: Pick<RenderModuleOptions, "env"> = {}): string {
	return env[RENDER_ENV.image] || RENDER_DEFAULT_IMAGE;
}

const extras = ({ fetch, webSocket, timeouts, onNote }: RenderModuleOptions) => ({
	...(fetch ? { fetch } : {}),
	...(webSocket ? { webSocket } : {}),
	...(timeouts ? { timeouts } : {}),
	...(onNote ? { onNote } : {}),
});

/** The provider the CLI runs; throws in words without the live switch, or when a setting is missing or wrong. */
export async function createProvider(options: RenderModuleOptions = {}): Promise<RenderProvider> {
	const { env = process.env, daemonPath } = options;
	live(env);
	return create({ ...settingsFromEnv(env), ...extras(options), ...(daemonPath === undefined ? {} : { daemonPath }), maxLifetimeMs: CONFORMANCE_MAX_LIFETIME_MS });
}

/** No run folder: a Render computer takes no mount yet. */
export async function mountFor(_kind: MountKind): Promise<RunFolder | undefined> {
	return undefined;
}

/** The Render host the live sweep (sweep.ts) lists and deletes through; it needs no live switch, since the sweep makes nothing. */
export async function createHost(options: Pick<RenderModuleOptions, "env" | "fetch" | "webSocket"> = {}): Promise<MachineHost> {
	return (await create({ ...settingsFromEnv(options.env ?? process.env), ...extras(options) })).host;
}

/** The same provider uploading a daemon that reports version <version>-drift, for the drift.version case. */
export async function createDriftedProvider(options: RenderModuleOptions = {}): Promise<RenderProvider> {
	const { env = process.env, buildDaemon = (version) => buildDriftDaemon("amd64", version) } = options;
	live(env);
	const daemonPath = await buildDaemon(DRIFT_VERSION);
	return create({ ...settingsFromEnv(env), ...extras(options), daemonPath, maxLifetimeMs: CONFORMANCE_MAX_LIFETIME_MS });
}
