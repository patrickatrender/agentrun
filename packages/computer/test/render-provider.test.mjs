// RenderProvider against a fake Render: a fetch that answers Render's REST API and data plane (render-public-api-1),
// and a WebSocket that speaks render.sandbox-exec.v1. The adapter's lifecycle
// is tested once, against its fake host (hosted-provider.test.mjs); this holds what Render's own host decides: what
// create sends, how a sandbox reads back, the labels file, list, delete, upload and the exec session's frames.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as registry from "../dist/providers.js";

const { RenderProvider, create, networkOf, machineOf, EXEC_SUBPROTOCOL, LABELS_FILE } = await import("../dist/render.js");
const { RENDER_ENV, settingsFromEnv, createProvider } = await import("../dist/conformance/render.js");

const KEY = "rnd_fake_computer_key_0123456789";
const OWNER = "tea-abcdefghij0123456789";
const SBX = "sbx-abcdefghij0123456789";
const NAME = "computer-0123456789ab";
const dir = mkdtempSync(join(tmpdir(), "computer-render-"));
const DAEMON_PATH = join(dir, "computerd");
writeFileSync(DAEMON_PATH, Buffer.from("a stand-in for computerd\n"));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const TIMEOUTS = { requestMs: 2_000, createMs: 2_000, uploadMs: 2_000, execMs: 2_000, helloMs: 1_000, probeMs: 1_000, listMs: 2_000, goneMs: 500, pollMs: 5, listedMs: 500 };

const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A fake Render: its sandboxes by id, every request recorded, and the labels file per sandbox. */
function fakeRender({ sessions = true } = {}) {
	const calls = [];
	const sandboxes = new Map();
	const files = new Map();
	const fetch = async (url, init = {}) => {
		const u = new URL(url);
		const body = init.body === undefined ? undefined : typeof init.body === "string" ? JSON.parse(init.body) : init.body;
		calls.push({ method: init.method, url: u, headers: init.headers, body });
		if (init.headers?.Authorization !== `Bearer ${KEY}` && u.hostname === "api.render.com") return json(401, { message: "unauthorized" });
		if (u.hostname.endsWith(".sandbox.onrender.com")) {
			const id = u.hostname.split(".")[0];
			if (u.pathname === "/runs/sync") {
				const command = body.command;
				if (command.startsWith("cat ")) return json(200, { stdout: files.get(id) ?? "", stderr: "", exit_code: 0 });
				const b64 = /printf %s (\S+) \| base64 -d/.exec(command)?.[1];
				if (b64) files.set(id, Buffer.from(b64, "base64").toString("utf8"));
				return json(200, { stdout: "", stderr: "", exit_code: 0 });
			}
			if (u.pathname === "/files/upload") return new Response(null, { status: 204 });
		}
		const path = u.pathname.replace(/^\/v1/, "");
		if (init.method === "POST" && path === "/sandboxes") {
			const sb = { id: SBX, name: body.name, status: "running", networkPolicy: { type: body.networkPolicy.type }, timeoutSeconds: body.timeoutSeconds, idleTimeoutSeconds: body.idleTimeoutSeconds, createdAt: new Date().toISOString(), region: "oregon", plan: "1c-2g" };
			sandboxes.set(sb.id, sb);
			return json(201, sb);
		}
		if (init.method === "GET" && path === "/sandboxes") {
			const name = u.searchParams.get("name");
			return json(200, [...sandboxes.values()].filter((sb) => !name || sb.name === name).map((sandbox) => ({ sandbox, cursor: sandbox.id })));
		}
		const token = /^\/sandboxes\/([^/]+)\/(runs|files)\/([a-z]+)\/token$/.exec(path);
		if (token) {
			const [, id, kind, operation] = token;
			if (operation === "session" && !sessions) return json(400, { message: 'invalid operation "session"' });
			const method = kind === "files" ? "PUT" : operation === "session" ? "GET" : "POST";
			return json(201, { executionId: "exe-1", token: `tok-${operation}`, uri: `https://${id}.sandbox.onrender.com/${kind}/${operation}`, method, expiresAt: new Date().toISOString() });
		}
		const one = /^\/sandboxes\/([^/]+)(\/terminate)?$/.exec(path);
		if (one) {
			const sb = sandboxes.get(one[1]);
			if (one[2]) {
				if (sb) sb.status = "terminated";
				return new Response(null, { status: 204 });
			}
			return sb ? json(200, sb) : json(404, { message: "not found" });
		}
		return json(404, { message: `no route ${init.method} ${path}` });
	};
	return { calls, sandboxes, files, fetch };
}

/** A WebSocket speaking render.sandbox-exec.v1: echoes stdin to stdout, exits 0 at close_stdin. */
function fakeSockets() {
	const opened = [];
	const factory = (url, init) => {
		const listeners = { open: [], message: [], close: [], error: [] };
		const emit = (type, event) => listeners[type].forEach((fn) => fn(event));
		const sent = [];
		const socket = {
			binaryType: "blob",
			bufferedAmount: 0,
			addEventListener: (type, fn) => listeners[type].push(fn),
			send(data) {
				sent.push(data);
				if (typeof data === "string") {
					const msg = JSON.parse(data);
					if (msg.type === "start") queueMicrotask(() => emit("message", { data: JSON.stringify({ type: "started", execution_id: "exe-1" }) }));
					if (msg.type === "close_stdin") queueMicrotask(() => emit("message", { data: JSON.stringify({ type: "exit", exit_code: 0 }) }));
					return;
				}
				const echo = new Uint8Array(data);
				echo[0] = 1;
				queueMicrotask(() => emit("message", { data: echo.buffer }));
			},
			close() {},
		};
		opened.push({ url, init, sent, socket });
		queueMicrotask(() => emit("open", {}));
		return socket;
	};
	return { opened, factory };
}

function setup(options = {}) {
	const render = fakeRender(options);
	const sockets = fakeSockets();
	const provider = new RenderProvider({ apiKey: KEY, ownerId: OWNER, fetch: render.fetch, webSocket: sockets.factory, daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
	return { render, sockets, provider, host: provider.host };
}

test("a Render computer is kind linux, a microVM, daemon child, network none read back, amd64, no mount, no extend", () => {
	const { provider } = setup();
	const caps = provider.capabilities();
	assert.equal(provider.id, "render");
	assert.equal(caps.isolation, "microvm");
	assert.deepEqual(caps.network, ["none"]);
	assert.deepEqual(caps.mount, []);
	assert.equal(provider.extend, undefined, "Render moves no timeout");
});

test("the options are checked in words, never echoing the key", () => {
	assert.throws(() => new RenderProvider({ ownerId: OWNER }), /apiKey/);
	assert.throws(() => new RenderProvider({ apiKey: KEY, ownerId: "acme" }), /workspace/);
	assert.throws(() => new RenderProvider({ apiKey: KEY, ownerId: OWNER, apiUrl: "http://api.example.com" }), /https/);
	assert.throws(() => new RenderProvider({ apiKey: KEY, ownerId: OWNER, maxLifetimeMs: 1_000 }), /maxLifetimeMs/);
	try {
		new RenderProvider({ apiKey: KEY, ownerId: "bad" });
	} catch (error) {
		assert.doesNotMatch(String(error), new RegExp(KEY));
	}
});

test("check() takes default, build:<name> and snapshot:<name> as the image, and refuses anything else", () => {
	const { host } = setup();
	assert.deepEqual(host.check({ image: "default" }), []);
	assert.deepEqual(host.check({ image: "build:agentrun-box" }), []);
	assert.deepEqual(host.check({ image: "snapshot:snp-abc123" }), []);
	assert.equal(host.check({ image: "ubuntu; rm -rf /" }).length, 1);
});

test("create sends the name, the lifetime as whole seconds (at least 60), no idle suspension, deny-all, the workspace and the build; labels are written by prepare and read back", async () => {
	const { host, render } = setup();
	const made = await host.create({ name: NAME, image: "build:box", labels: { "agentrun.computer": "1", "agentrun.computer.name": NAME, run: "r1" }, lifetimeMs: 1_500, network: "none" }, { timeoutMs: 1_000 });
	assert.deepEqual(made, { ok: true, value: { id: SBX } });
	const sent = render.calls.find((c) => c.method === "POST" && c.url.pathname === "/v1/sandboxes");
	assert.deepEqual(sent.body, { ownerId: OWNER, name: NAME, timeoutSeconds: 60, idleTimeoutSeconds: 0, networkPolicy: { type: "deny-all" }, buildName: "box" });
	assert.equal(sent.headers.Authorization, `Bearer ${KEY}`);
	assert.deepEqual(await host.prepare(SBX, { timeoutMs: 1_000 }), { ok: true, value: undefined });
	const sync = render.calls.find((c) => c.url.pathname === "/runs/sync");
	assert.match(sync.body.command, new RegExp(`> ${LABELS_FILE}\\.new`));
	assert.equal(sync.headers.Authorization, "Bearer tok-sync", "the data plane takes the connect token, never the API key");
	assert.equal(JSON.parse(render.files.get(SBX)).run, "r1");

	// A second provider instance, which did not make it, reads the labels from the file.
	const other = new RenderProvider({ apiKey: KEY, ownerId: OWNER, fetch: render.fetch, daemonPath: DAEMON_PATH, timeouts: TIMEOUTS }).host;
	const got = await other.get(SBX, { timeoutMs: 1_000 });
	assert.equal(got.value.labels.run, "r1");
	assert.equal(got.value.network, "none");
	assert.equal(got.value.state, "running");
	assert.ok(got.value.endsAt instanceof Date);
	assert.equal(got.value.drift, undefined);
	const listed = await other.list({ run: "r1" }, { timeoutMs: 1_000 });
	assert.deepEqual(listed.value.map((m) => m.id), [SBX]);
	assert.deepEqual((await other.list({ run: "r2" }, { timeoutMs: 1_000 })).value, []);
	const byName = await other.list({ "agentrun.computer": "1", "agentrun.computer.name": NAME }, { timeoutMs: 1_000 });
	assert.deepEqual(byName.value.map((m) => m.id), [SBX]);
	assert.equal(render.calls.filter((c) => c.url.searchParams.get("name") === NAME).length, 1, "a list by name asks Render by name");
});

test("delete terminates, and a terminated or missing sandbox reads as gone", async () => {
	const { host, render } = setup();
	await host.create({ name: NAME, image: "default", labels: {}, lifetimeMs: 600_000, network: "none" }, { timeoutMs: 1_000 });
	assert.deepEqual(await host.delete(SBX, { timeoutMs: 1_000 }), { ok: true, value: undefined });
	assert.ok(render.calls.some((c) => c.method === "POST" && c.url.pathname === `/v1/sandboxes/${SBX}/terminate`));
	assert.deepEqual(await host.get(SBX, { timeoutMs: 1_000 }), { ok: true, value: undefined });
	assert.deepEqual(await host.get("sbx-nothere0000000000", { timeoutMs: 1_000 }), { ok: true, value: undefined });
});

test("upload PUTs the bytes to the files data plane with the path in the token request", async () => {
	const { host, render } = setup();
	await host.upload(SBX, "/tmp/computerd", new Uint8Array([1, 2, 3]), { timeoutMs: 1_000 });
	const token = render.calls.find((c) => c.url.pathname.endsWith("/files/upload/token"));
	assert.equal(token.url.searchParams.get("path"), "/tmp/computerd");
	const put = render.calls.find((c) => c.url.pathname === "/files/upload");
	assert.equal(put.method, "PUT");
	assert.equal(put.headers.Authorization, "Bearer tok-upload");
});

test("exec opens a render.sandbox-exec.v1 session: start with the quoted argv, stdin as stream-0 frames, stdout from stream-1, close_stdin, the exit code", async () => {
	const { host, sockets } = setup();
	const started = await host.exec(SBX, ["sh", "-c", "cat", "it's"], { stdin: true }, { timeoutMs: 1_000 });
	assert.equal(started.ok, true, JSON.stringify(started.error));
	const [{ url, init, sent }] = sockets.opened;
	assert.equal(url, `wss://${SBX}.sandbox.onrender.com/runs/session`);
	assert.deepEqual(init, { headers: { Authorization: "Bearer tok-session" }, protocols: [EXEC_SUBPROTOCOL] });
	assert.deepEqual(JSON.parse(sent[0]), { type: "start", command: "sh -c cat 'it'\\''s'" });
	const proc = started.value;
	const out = (async () => {
		const parts = [];
		for await (const chunk of proc.stdout) parts.push(Buffer.from(chunk));
		return Buffer.concat(parts).toString("utf8");
	})();
	await proc.write(new Uint8Array(Buffer.from("hello")));
	assert.equal(sent[1][0], 0, "stdin's stream byte");
	await proc.end();
	assert.equal(await proc.wait(), 0);
	assert.equal(await out, "hello");
	assert.deepEqual(JSON.parse(sent.at(-1)), { type: "close_stdin" });
});

test("exec answers unsupported, in words, while Render does not offer runs/session", async () => {
	const { host } = setup({ sessions: false });
	const started = await host.exec(SBX, ["true"], { stdin: false }, { timeoutMs: 1_000 });
	assert.equal(started.ok, false);
	assert.equal(started.error.code, "unsupported");
	assert.match(started.error.message, /exec sessions with stdin/);
});

test("the network reads back as Render reports it: deny-all is none, allow-all open, an allow list another", () => {
	assert.equal(networkOf({ type: "deny-all" }), "none");
	assert.equal(networkOf({ type: "allow-all" }), "open");
	assert.ok(typeof networkOf({ type: "allow-list", rules: [{ domain: "example.com" }] }) === "object");
	assert.ok(typeof networkOf(undefined) === "object");
});

test("a sandbox whose timeout or idle timeout reads back other than create gave is drift", () => {
	const sb = { id: SBX, name: NAME, status: "running", networkPolicy: { type: "deny-all" }, timeoutSeconds: 120, idleTimeoutSeconds: 300, createdAt: new Date().toISOString() };
	const machine = machineOf(sb, { "agentrun.computer.timeout-s": "60" });
	assert.equal(machine.drift.length, 2);
	assert.equal(machineOf({ ...sb, timeoutSeconds: 0, idleTimeoutSeconds: 0 }, {}).drift.length, 1, "no timeout is never ended");
});

test("testConnection lists one page and counts this provider's sandboxes; a refused key is unauthorized", async () => {
	const { host } = setup();
	const tested = await host.testConnection({ timeoutMs: 1_000 });
	assert.equal(tested.ok, true);
	assert.match(tested.value.detail, /Render answered: 0 computers/);
	const refused = new RenderProvider({ apiKey: "fake-test-key", ownerId: OWNER, fetch: fakeRender().fetch }).host;
	const result = await refused.testConnection({ timeoutMs: 1_000 });
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "unauthorized");
});

test("the registry builds Render from its options alone", async () => {
	const provider = await registry.providerFor("render", { apiKey: KEY, ownerId: OWNER });
	assert.equal(provider.id, "render");
	await assert.rejects(create({ ownerId: OWNER }), /apiKey/);
});

test("the conformance module reads COMPUTER_RENDER_* alone and needs its live switch first", async () => {
	assert.throws(() => settingsFromEnv({ RENDER_API_KEY: KEY }), /COMPUTER_RENDER_API_KEY/);
	assert.deepEqual(settingsFromEnv({ [RENDER_ENV.key]: KEY, [RENDER_ENV.workspace]: OWNER }), { apiKey: KEY, ownerId: OWNER });
	await assert.rejects(createProvider({ env: { [RENDER_ENV.key]: KEY, [RENDER_ENV.workspace]: OWNER } }), /AGENTRUN_COMPUTER_LIVE_RENDER/);
});
