// The Render host: a Render sandbox (a Firecracker microVM) per computer, over Render's public REST API with fetch and
// no SDK. Render runs its own agent in the guest, so computerd is a child: its upload goes through the files data
// plane (a connect token, then PUT), and every command runs as root through a connect token's run. The rest of the
// computer is the shared machine-host adapter's (./hosted/provider.ts).
//
// What Render gives, and how this host uses it (render.com/docs/sandboxes; api-docs.render.com, render-public-api-1):
// - POST /sandboxes makes one with timeoutSeconds, Render's own end, and idleTimeoutSeconds 0, so it never suspends; it
//   answers status creating, and get polls until running. POST /sandboxes/{id}/terminate answers 204 for one gone.
// - A sandbox carries a name (computer-<12 hex>) and no labels: the adapter's labels are a file root writes in the
//   sandbox once it runs (prepare), read back through a run, and kept here for the sandboxes this host made.
// - networkPolicy deny-all is enforced on the host, outside the guest, and runs and files still work under it. allow-all is the open network an Archil computer's root would need (no mount is offered yet).
// - Commands: POST /sandboxes/{id}/runs/{sync|session}/token mints a connect token, whose uri is the sandbox's data
//   plane. sync runs `bash -c <command>` as root and answers its output; session (render.sandbox-exec.v1, a WebSocket)
//   runs one command with stdin, stdout and stderr as binary frames. Session is not yet in Render's public API: until
//   it is, exec answers unsupported, in words, and so does every computer's start.
// - Render has no call that moves a sandbox's timeout, so this host has no setTimer: deadline.extend is not offered.
import { RENDER, RENDER_DEFAULT_IMAGE } from "./descriptors/render.js";
import { COMPUTER_LABEL } from "./drift.js";
import type { HostCall, HostFacts, Machine, MachineHost, MachineProcess, MachineRequest } from "./host.js";
import { HostedProvider, type HostedOptions, type HostedTimeouts, NAME_LABEL } from "./hosted/provider.js";
import { words } from "./hosted/process.js";
import { shellLine } from "./hosted/scripts.js";
import type { KindCapabilities } from "./kinds.js";
import type { MountKind } from "./mount.js";
import type { ComputerSpec, NetworkPolicy, Refusal } from "./provider.js";
import { type ComputerErrorCode, failFor, ok, type Result } from "./result.js";
import { countTested } from "./test-connection.js";

/** This module's failures: one with code vendor names Render. */
const fail = failFor("render");

export const DEFAULT_API_URL = "https://api.render.com/v1";
/** The exec session's WebSocket subprotocol. */
export const EXEC_SUBPROTOCOL = "render.sandbox-exec.v1";
/** Where root keeps the adapter's labels in the sandbox: a directory only root reads. */
export const LABELS_DIR = "/var/lib/agentrun-computer";
export const LABELS_FILE = `${LABELS_DIR}/labels.json`;
/** The timeout create gave Render, in s: drift when Render reads another back. */
const TIMEOUT_LABEL = `${COMPUTER_LABEL}.timeout-s`;
/** Render's shortest timeout; 0 is none, which this host never asks. */
const MIN_TIMEOUT_S = 60;
/** The longest lifetime a Render computer takes by default: 1 h. A workspace's own cap may be higher or lower. */
const DEFAULT_MAX_MS = 60 * 60_000;
/** The most this host lets a computer live, whatever the workspace allows: 24 h. */
const MOST_MS = 24 * 60 * 60_000;
/** A page of the list: Render's most. */
const PAGE = 100;
const MAX_PAGES = 100;
/** One stdin frame's data: under Render's 1 MiB read limit of a client message, with its stream byte. */
const FRAME_MAX = 512 * 1024;
/** Writes wait while this much is queued on the socket. */
const HIGH_WATER = 4 * 1024 * 1024;
const NAME = /^computer-[0-9a-f]{12}$/;
const OWNER = /^(tea|usr)-[a-z0-9]{10,40}$/;
const SANDBOX_ID = /^sbx-[a-z0-9]{10,40}$/;
/** An image: "default" (Render's base), or a build or snapshot by its name or id. */
const IMAGE = /^(default|(build|snapshot):[A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;

/** The mount kinds a Render computer takes, as capabilities().mount declares them: none yet. */
export const MOUNT: readonly MountKind[] = RENDER.mounts;
export const CAPABILITIES: readonly KindCapabilities[] = RENDER.capabilities;

/** The parts of a WebSocket the host uses: Node's global WebSocket, or a fake in tests. */
export interface RenderWebSocket {
	binaryType: string;
	readonly bufferedAmount: number;
	addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: unknown; code?: number; message?: string }) => void): void;
	send(data: string | Uint8Array): void;
	close(code?: number): void;
}

export type RenderWebSocketFactory = (url: string, init: { headers: Record<string, string>; protocols: string[] }) => RenderWebSocket;

export interface RenderProviderOptions extends Omit<HostedOptions, "label" | "kind" | "desktop"> {
	/** The Render API key. The caller passes it; this provider never reads the environment and never puts it in a computer. */
	apiKey: string;
	/** The workspace every sandbox is made in and listed from (tea-... or usr-...). */
	ownerId: string;
	/** Render's API; default https://api.render.com/v1. */
	apiUrl?: string;
	/** For tests: every API and data-plane call. Default the global fetch. */
	fetch?: typeof fetch;
	/** For tests: every exec session opens through it. Default Node's global WebSocket. */
	webSocket?: RenderWebSocketFactory;
}

export type RenderOptions = RenderProviderOptions;

/** A Render call that failed: its status, and Render's message. */
export class RenderApiError extends Error {
	override name = "RenderApiError";
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

/** A sandbox as Render's API reads it (sandbox in render-public-api-1). */
export interface RenderSandbox {
	id: string;
	name?: string;
	status: "creating" | "running" | "suspending" | "suspended" | "resuming" | "errored" | "terminated";
	networkPolicy?: { type?: string; default?: string; rules?: unknown[] };
	timeoutSeconds?: number;
	idleTimeoutSeconds?: number;
	createdAt?: string;
	terminatedAt?: string;
}

/** A connect token (connectTokenResponse): the data plane's uri, its method, and the bearer token. */
interface ConnectToken {
	token: string;
	uri: string;
	method: string;
}

function codeOf(error: unknown): ComputerErrorCode {
	const name = (error as { name?: unknown } | null)?.name;
	if (name === "AbortError") return "aborted";
	if (name === "TimeoutError") return "timeout";
	if (error instanceof RenderApiError) {
		const { status } = error;
		if (status === 401 || status === 403) return "denied";
		if (status === 404) return "not_found";
		if (status === 400 || status === 422) return "invalid";
		if (status === 409) return "exists";
		if (status === 429) return "limit";
		if (status === 501) return "unsupported";
	}
	return "vendor";
}

/**
 * A sandbox's network as Render reports it. None is deny-all with no rules; open is allow-all with none. An allow
 * list, or any rule, is another network in words, never one it might widen to.
 */
export function networkOf(policy: RenderSandbox["networkPolicy"]): NetworkPolicy {
	const type = policy?.type;
	const rules = Array.isArray(policy?.rules) ? policy.rules.length : 0;
	if (rules > 0) return { other: `${rules} network rules, which this provider never makes` };
	if (type === "deny-all") return "none";
	if (type === "allow-all") return "open";
	return { other: type === undefined ? "Render reported no network policy" : `network policy ${type}` };
}

const STATES: Record<RenderSandbox["status"], Machine["state"]> = {
	creating: "starting",
	resuming: "starting",
	running: "running",
	suspending: "stopped",
	suspended: "stopped",
	errored: "failed",
	terminated: "going",
};

/** The labels a sandbox carries by its name alone, before its labels file is read: ours, and its name. */
const nameLabels = (name: string | undefined): Record<string, string> => (name !== undefined && NAME.test(name) ? { [COMPUTER_LABEL]: "1", [NAME_LABEL]: name } : {});

/** A sandbox as the adapter reads a machine: Render's states, network, timeout and create's drift. */
export function machineOf(sb: RenderSandbox, labels: Record<string, string> | undefined): Machine {
	const all = { ...nameLabels(sb.name), ...(labels ?? {}) };
	const created = sb.createdAt === undefined ? Number.NaN : Date.parse(sb.createdAt);
	const timeout = sb.timeoutSeconds;
	const drift: string[] = [];
	if (typeof timeout !== "number" || timeout <= 0) drift.push(`timeoutSeconds: Render read back ${JSON.stringify(timeout)}, so it might never end the computer`);
	else if (all[TIMEOUT_LABEL] !== undefined && String(timeout) !== all[TIMEOUT_LABEL]) drift.push(`timeoutSeconds: declared ${all[TIMEOUT_LABEL]}, read back ${timeout}`);
	if (sb.idleTimeoutSeconds !== undefined && sb.idleTimeoutSeconds !== 0) drift.push(`idleTimeoutSeconds: declared 0, read back ${sb.idleTimeoutSeconds}: Render would suspend an idle computer`);
	return {
		id: sb.id,
		labels: all,
		state: STATES[sb.status] ?? "going",
		...(sb.status === "errored" ? { why: "Render reported the sandbox errored" } : {}),
		network: networkOf(sb.networkPolicy),
		...(Number.isNaN(created) ? {} : { createdAt: new Date(created) }),
		...(Number.isNaN(created) || typeof timeout !== "number" || timeout <= 0 ? {} : { endsAt: new Date(created + timeout * 1000) }),
		timerMoved: false,
		...(drift.length > 0 ? { drift } : {}),
	};
}

/** A stream fed by the socket's frames, read as an async iterable until it ends. */
function feed(): { push(bytes: Uint8Array): void; end(): void; iterable: AsyncIterable<Uint8Array> } {
	const queue: Uint8Array[] = [];
	let ended = false;
	let wake: (() => void) | undefined;
	const nudge = () => {
		const waiting = wake;
		wake = undefined;
		waiting?.();
	};
	return {
		push(bytes) {
			if (ended) return;
			queue.push(bytes);
			nudge();
		},
		end() {
			ended = true;
			nudge();
		},
		iterable: {
			async *[Symbol.asyncIterator]() {
				for (;;) {
					const next = queue.shift();
					if (next !== undefined) yield next;
					else if (ended) return;
					else await new Promise<void>((done) => (wake = done));
				}
			},
		},
	};
}

const bytesOf = (data: unknown): Uint8Array | undefined => {
	if (data instanceof Uint8Array) return data;
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	return undefined;
};

/** A spec's image as Render's create takes it: nothing for the base, else a build's or snapshot's name or id. */
function imageFields(image: string): Record<string, string> {
	if (image === RENDER_DEFAULT_IMAGE || image === "") return {};
	const [kind, ref] = [image.slice(0, image.indexOf(":")), image.slice(image.indexOf(":") + 1)];
	const byId = /^(bld|snp|snap)-/.test(ref);
	if (kind === "build") return byId ? { buildId: ref } : { buildName: ref };
	return byId ? { snapshotId: ref } : { snapshotName: ref };
}

/** Render's sandboxes as a MachineHost (../host.ts). */
class RenderHost implements MachineHost {
	readonly id = "render";
	readonly facts: HostFacts;
	readonly #apiKey: string;
	readonly #ownerId: string;
	readonly #apiUrl: string;
	readonly #fetch: typeof fetch;
	readonly #webSocket: RenderWebSocketFactory;
	/** The labels of each sandbox this host made or read, by id: Render keeps none of its own. */
	readonly #labels = new Map<string, Record<string, string>>();

	constructor({ apiKey, ownerId, apiUrl, fetch: given, webSocket }: { apiKey: string; ownerId: string; apiUrl: string; fetch?: typeof fetch; webSocket?: RenderWebSocketFactory }) {
		this.#apiKey = apiKey;
		this.#ownerId = ownerId;
		this.#apiUrl = apiUrl.replace(/\/+$/, "");
		this.#fetch = given ?? fetch;
		this.#webSocket = webSocket ?? ((url, init) => new WebSocket(url, init as never) as unknown as RenderWebSocket);
		this.facts = {
			daemon: "child",
			isolation: "microvm",
			lifetime: "vendor",
			maxLifetimeMs: MOST_MS,
			arch: "amd64",
			// Render's guest agent listens on no TCP port in the guest.
			vendorAgentPorts: [],
			networkReadBack: true,
			network: [...RENDER.network],
			mounts: [...MOUNT],
			release: ["delete"],
		};
	}

	errorCode(error: unknown): ComputerErrorCode {
		return codeOf(error);
	}

	check(spec: ComputerSpec): Refusal[] {
		const image = (spec as { image?: unknown } | null)?.image;
		if (typeof image === "string" && image !== "" && !IMAGE.test(image)) {
			return [{ field: "image", message: `an image is "${RENDER_DEFAULT_IMAGE}" (Render's base), "build:<name or id>" or "snapshot:<name or id>"` }];
		}
		return [];
	}

	/** One API call: JSON in and out, the key as bearer, bounded by ctx. A failure status throws RenderApiError. */
	async #api<T>(method: string, path: string, ctx: HostCall, body?: unknown): Promise<{ status: number; json: T | undefined }> {
		const signal = ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(ctx.timeoutMs)]) : AbortSignal.timeout(ctx.timeoutMs);
		const response = await this.#fetch(`${this.#apiUrl}${path}`, {
			method,
			headers: { Authorization: `Bearer ${this.#apiKey}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal,
		});
		const text = await response.text();
		if (!response.ok) throw new RenderApiError(response.status, `${method} ${path.split("?")[0]} answered ${response.status}: ${messageOf(text)}`);
		return { status: response.status, json: text === "" ? undefined : (JSON.parse(text) as T) };
	}

	#owner = () => `ownerId=${encodeURIComponent(this.#ownerId)}`;

	/** A connect token for one of the sandbox's runs (sync, session) or files (upload, download). */
	async #token(id: string, kind: "runs" | "files", operation: string, ctx: HostCall, path?: string): Promise<ConnectToken> {
		const query = `${this.#owner()}${path === undefined ? "" : `&path=${encodeURIComponent(path)}`}`;
		const { json } = await this.#api<ConnectToken>("POST", `/sandboxes/${encodeURIComponent(id)}/${kind}/${operation}/token?${query}`, ctx);
		if (typeof json?.token !== "string" || typeof json.uri !== "string") throw new RenderApiError(502, `the ${kind}/${operation} token answer has no token or uri`);
		return json;
	}

	/** A command through a sync run, as root, with no stdin: its output and exit code. */
	async #run(id: string, command: string, ctx: HostCall): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const token = await this.#token(id, "runs", "sync", ctx);
		const signal = ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(ctx.timeoutMs)]) : AbortSignal.timeout(ctx.timeoutMs);
		const response = await this.#fetch(token.uri, {
			method: token.method || "POST",
			headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ command }),
			signal,
		});
		const text = await response.text();
		if (!response.ok) throw new RenderApiError(response.status, `a run in ${id} answered ${response.status}: ${messageOf(text)}`);
		const json = JSON.parse(text) as { stdout?: string; stderr?: string; exit_code?: number };
		return { stdout: json.stdout ?? "", stderr: json.stderr ?? "", exitCode: typeof json.exit_code === "number" ? json.exit_code : -1 };
	}

	/** A sandbox's labels: kept, or read from the file root wrote; undefined while it cannot be read (not running, none written). */
	async #labelsOf(sb: RenderSandbox, ctx: HostCall): Promise<Record<string, string> | undefined> {
		const known = this.#labels.get(sb.id);
		if (known !== undefined || sb.status !== "running" || sb.name === undefined || !NAME.test(sb.name)) return known;
		const read = await this.#run(sb.id, `cat ${LABELS_FILE} 2>/dev/null || true`, ctx);
		if (read.stdout.trim() === "") return undefined;
		try {
			const parsed = JSON.parse(read.stdout) as unknown;
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || Object.values(parsed).some((v) => typeof v !== "string")) return undefined;
			const labels = parsed as Record<string, string>;
			this.#labels.set(sb.id, labels);
			return labels;
		} catch {
			return undefined;
		}
	}

	/**
	 * POST /sandboxes: the request's name, the lifetime as Render's timeout (whole seconds, at least Render's 60), no idle
	 * suspension, deny-all unless the adapter asks open. The labels are kept here until prepare writes them in.
	 */
	async create(req: MachineRequest, ctx: HostCall): Promise<Result<{ id: string }>> {
		const timeoutSeconds = Math.max(MIN_TIMEOUT_S, Math.ceil((req.lifetimeMs ?? 0) / 1000));
		const body = {
			ownerId: this.#ownerId,
			name: req.name,
			timeoutSeconds,
			idleTimeoutSeconds: 0,
			networkPolicy: { type: req.network === "open" ? "allow-all" : "deny-all" },
			...imageFields(req.image),
		};
		const { json } = await this.#api<RenderSandbox>("POST", "/sandboxes", { timeoutMs: ctx.timeoutMs }, body);
		if (typeof json?.id !== "string" || !SANDBOX_ID.test(json.id)) return fail("vendor", "POST /sandboxes answered no sandbox id");
		this.#labels.set(json.id, { ...req.labels, [TIMEOUT_LABEL]: String(timeoutSeconds) });
		return ok({ id: json.id });
	}

	/** Writes the labels file, as root, in a directory only root reads, once the sandbox runs and before the daemon goes in. */
	async prepare(id: string, ctx: HostCall): Promise<Result<void>> {
		const labels = this.#labels.get(id);
		if (labels === undefined) return fail("invalid", `${id} was not made by this provider instance, so it has no labels to write`);
		const b64 = Buffer.from(JSON.stringify(labels), "utf8").toString("base64");
		const ran = await this.#run(id, `umask 077 && mkdir -p ${LABELS_DIR} && chmod 700 ${LABELS_DIR} && printf %s ${b64} | base64 -d > ${LABELS_FILE}.new && mv ${LABELS_FILE}.new ${LABELS_FILE}`, ctx);
		return ran.exitCode === 0 ? ok(undefined) : fail("vendor", `writing the labels in ${id} exited with ${ran.exitCode}: ${`${ran.stdout} ${ran.stderr}`.trim().slice(0, 300)}`);
	}

	/** GET /sandboxes/{id}; one Render no longer has, or one terminated, is none. */
	async get(id: string, ctx: HostCall): Promise<Result<Machine | undefined>> {
		let sb: RenderSandbox | undefined;
		try {
			sb = (await this.#api<RenderSandbox>("GET", `/sandboxes/${encodeURIComponent(id)}?${this.#owner()}`, ctx)).json;
		} catch (error) {
			if (codeOf(error) === "not_found") return ok(undefined);
			throw error;
		}
		if (sb === undefined || sb.status === "terminated") return ok(undefined);
		return ok(machineOf(sb, await this.#labelsOf(sb, ctx)));
	}

	/**
	 * Every sandbox of the workspace named computer-<12 hex> (by the name label's value alone when given), every page, but
	 * the terminated, each with its labels, and of those every one that carries all of these labels.
	 */
	async list(labels: Record<string, string>, ctx: HostCall): Promise<Result<Machine[]>> {
		const until = Date.now() + ctx.timeoutMs;
		const left = (): HostCall => ({ timeoutMs: Math.max(1, until - Date.now()), ...(ctx.signal ? { signal: ctx.signal } : {}) });
		const name = labels[NAME_LABEL];
		const found: RenderSandbox[] = [];
		let cursor: string | undefined;
		for (let page = 0; ; page++) {
			if (page >= MAX_PAGES) return fail("vendor", `GET /sandboxes ran past ${MAX_PAGES} pages`);
			const query = `${this.#owner()}&limit=${PAGE}${name === undefined ? "" : `&name=${encodeURIComponent(name)}`}${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
			const { json } = await this.#api<Array<{ sandbox?: RenderSandbox; cursor?: string }>>("GET", `/sandboxes?${query}`, left());
			if (!Array.isArray(json)) return fail("vendor", "GET /sandboxes: a page that is not a list of sandboxes");
			for (const row of json) if (typeof row?.sandbox?.id === "string") found.push(row.sandbox);
			cursor = json.at(-1)?.cursor;
			if (json.length < PAGE || cursor === undefined) break;
		}
		const machines: Machine[] = [];
		for (const sb of found) {
			if (sb.status === "terminated" || sb.name === undefined || !NAME.test(sb.name)) continue;
			if (Date.now() >= until) return fail("timeout", `${machines.length} sandboxes were read back, ${sb.id} and any after it were not`);
			const machine = machineOf(sb, await this.#labelsOf(sb, left()));
			if (Object.entries(labels).every(([key, value]) => machine.labels[key] === value)) machines.push(machine);
		}
		return ok(machines);
	}

	/** POST /sandboxes/{id}/terminate, never signalled: a delete that cleans up after an abort must outlive it. Gone is done. */
	async delete(id: string, ctx: HostCall): Promise<Result<void>> {
		try {
			await this.#api("POST", `/sandboxes/${encodeURIComponent(id)}/terminate?${this.#owner()}`, { timeoutMs: ctx.timeoutMs });
		} catch (error) {
			if (codeOf(error) !== "not_found") throw error;
		}
		this.#labels.delete(id);
		return ok(undefined);
	}

	/** The files data plane: an upload token for this path, then PUT the bytes, as root. */
	async upload(id: string, path: string, bytes: Uint8Array, ctx: HostCall): Promise<Result<void>> {
		const token = await this.#token(id, "files", "upload", ctx, path);
		const signal = ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(ctx.timeoutMs)]) : AbortSignal.timeout(ctx.timeoutMs);
		const response = await this.#fetch(token.uri, {
			method: token.method || "PUT",
			headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/octet-stream" },
			body: bytes as unknown as BodyInit,
			signal,
		});
		if (!response.ok) throw new RenderApiError(response.status, `the upload to ${path} answered ${response.status}: ${messageOf(await response.text())}`);
		return ok(undefined);
	}

	/**
	 * One exec session (render.sandbox-exec.v1): argv quoted as one command, run by bash as root. It answers once Render
	 * says started. Stdin goes as binary frames (stream byte 0), end is close_stdin, and the process ends when the socket
	 * closes: a command that must outlive it detaches itself (the adapter's start uses setsid).
	 */
	async exec(id: string, argv: readonly string[], _opts: { stdin: boolean }, ctx: HostCall): Promise<Result<MachineProcess>> {
		let token: ConnectToken;
		try {
			token = await this.#token(id, "runs", "session", ctx);
		} catch (error) {
			if (error instanceof RenderApiError && (error.status === 400 || error.status === 422)) {
				return fail("unsupported", `Render does not offer exec sessions with stdin to this workspace yet (runs/session): ${error.message}`);
			}
			throw error;
		}
		const url = token.uri.replace(/^http/, "ws");
		const socket = this.#webSocket(url, { headers: { Authorization: `Bearer ${token.token}` }, protocols: [EXEC_SUBPROTOCOL] });
		socket.binaryType = "arraybuffer";
		const out = feed();
		const err = feed();
		let ended = false;
		let resolveExit!: (code: number) => void;
		const exited = new Promise<number>((done) => (resolveExit = done));
		const finish = (code: number) => {
			if (ended) return;
			ended = true;
			out.end();
			err.end();
			resolveExit(code);
		};
		const started = new Promise<Result<void>>((answer) => {
			socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "start", command: shellLine(argv) })));
			socket.addEventListener("message", ({ data }) => {
				const bytes = bytesOf(data);
				if (bytes !== undefined) {
					if (bytes.length === 0) return;
					const chunk = bytes.subarray(1);
					if (bytes[0] === 1) out.push(new Uint8Array(chunk));
					else if (bytes[0] === 2) err.push(new Uint8Array(chunk));
					return;
				}
				if (typeof data !== "string") return;
				let message: { type?: string; exit_code?: number; message?: string };
				try {
					message = JSON.parse(data);
				} catch {
					return;
				}
				if (message.type === "started") answer(ok(undefined));
				else if (message.type === "exit") finish(typeof message.exit_code === "number" ? message.exit_code : -1);
				else if (message.type === "error") {
					answer(fail("vendor", `Render's exec session in ${id} failed: ${message.message ?? "no message"}`));
					finish(-1);
				}
			});
			socket.addEventListener("error", (event) => {
				answer(fail("vendor", `the exec session in ${id} failed: ${event.message ?? "a socket error"}`));
				finish(-1);
			});
			socket.addEventListener("close", ({ code }) => {
				answer(fail("vendor", `the exec session in ${id} closed (${code ?? "no code"}) before Render said it started`));
				finish(-1);
			});
		});
		const signal = ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(ctx.timeoutMs)]) : AbortSignal.timeout(ctx.timeoutMs);
		const aborted = new Promise<Result<void>>((answer) => signal.addEventListener("abort", () => answer(fail(codeOf(signal.reason), `the exec session in ${id} did not start: ${words(signal.reason)}`)), { once: true }));
		const begun = await Promise.race([started, aborted]);
		if (!begun.ok) {
			socket.close(1000);
			finish(-1);
			return begun;
		}
		const drained = async () => {
			while (!ended && socket.bufferedAmount > HIGH_WATER) await new Promise((wake) => setTimeout(wake, 5));
		};
		return ok({
			stdout: out.iterable,
			stderr: err.iterable,
			write: async (bytes) => {
				for (let at = 0; at < bytes.length; at += FRAME_MAX) {
					if (ended) throw new Error(`the process in ${id} has ended`);
					await drained();
					const piece = bytes.subarray(at, at + FRAME_MAX);
					const frame = new Uint8Array(piece.length + 1);
					frame[0] = 0;
					frame.set(piece, 1);
					socket.send(frame);
				}
			},
			end: async () => {
				if (!ended) socket.send(JSON.stringify({ type: "close_stdin" }));
			},
			wait: () => exited,
			kill: async () => {
				try {
					if (!ended) socket.send(JSON.stringify({ type: "signal", signal: "SIGKILL" }));
					socket.close(1000);
				} catch {}
				finish(-1);
			},
		});
	}

	/** Settings' test: one page of the workspace's sandboxes, counted by this provider's names; it makes nothing. */
	async testConnection(ctx: HostCall): Promise<Result<{ detail: string }>> {
		try {
			const { json } = await this.#api<Array<{ sandbox?: RenderSandbox }>>("GET", `/sandboxes?${this.#owner()}&limit=${PAGE}`, ctx);
			if (!Array.isArray(json)) return countTested("Render", fail("vendor", "GET /sandboxes: a page that is not a list of sandboxes"));
			const count = json.filter((row) => row?.sandbox?.status !== "terminated" && NAME.test(row?.sandbox?.name ?? "")).length;
			return countTested("Render", ok({ count, more: json.length >= PAGE }));
		} catch (error) {
			return countTested("Render", fail(codeOf(error), words(error)));
		}
	}
}

/** Render's message from an error body, never more than a line. */
function messageOf(text: string): string {
	try {
		const json = JSON.parse(text) as { message?: unknown };
		if (typeof json?.message === "string") return json.message.slice(0, 300);
	} catch {}
	return text.slice(0, 300) || "no message";
}

/** The Render provider: the shared adapter over RenderHost. Kind linux only: a Render sandbox has no screen. */
export class RenderProvider extends HostedProvider {
	constructor(options: RenderProviderOptions) {
		const { apiKey, ownerId, apiUrl = DEFAULT_API_URL, fetch: given, webSocket, maxLifetimeMs = DEFAULT_MAX_MS, ...rest } = options ?? ({} as RenderProviderOptions);
		if (typeof apiKey !== "string" || apiKey === "") throw new Error("options.apiKey, the Render API key, is required: the provider reads no environment, so the caller passes it");
		if (typeof ownerId !== "string" || !OWNER.test(ownerId)) throw new Error("options.ownerId is the Render workspace sandboxes are made in, such as tea-... (or usr-... for a personal one)");
		let parsed: URL;
		try {
			parsed = new URL(apiUrl);
		} catch {
			throw new Error(`the Render API URL must be a URL such as ${DEFAULT_API_URL}`);
		}
		if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname))) throw new Error("the Render API URL must be https (http only on loopback, for a test)");
		if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < MIN_TIMEOUT_S * 1000 || maxLifetimeMs > MOST_MS) {
			throw new Error(`maxLifetimeMs must be a whole number of ms from ${MIN_TIMEOUT_S * 1000} (Render's shortest timeout) to ${MOST_MS} (24 h); the workspace's own cap applies too`);
		}
		const host = new RenderHost({ apiKey, ownerId, apiUrl, ...(given ? { fetch: given } : {}), ...(webSocket ? { webSocket } : {}) });
		super(host, { ...rest, label: "Render", kind: "linux", maxLifetimeMs });
	}
}

/**
 * A RenderProvider from its options alone; it reads no environment. The key is options.apiKey and nowhere else (serve
 * passes its RENDER_API_KEY), the workspace options.ownerId. Throws in words when an option is missing or wrong, never
 * echoing the key.
 */
export async function create(options: RenderOptions): Promise<RenderProvider> {
	return new RenderProvider(options);
}

/** The conformance CLI's module for Render: its live switch, its cap and the drifted twin. */
export const conformance = () => import("./conformance/render.js");

export type { HostedTimeouts };
