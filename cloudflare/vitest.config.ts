import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";
import { privateKey } from "./test/github-key.ts";

// Miniflare keeps D1 as SQLite under the OS temp dir and fsyncs every write, so
// other processes' disk I/O stalls each statement and the route tests time out.
// The test database is disposable: keep Miniflare's temp dir in RAM where Linux has one.
if (existsSync("/dev/shm")) process.env.TMPDIR = "/dev/shm";

// Use the deploy config's bindings locally; tests never contact a Cloudflare account.
export default defineConfig({
	plugins: [
		cloudflareTest(async () => ({
			wrangler: { configPath: "./wrangler.jsonc" },
			remoteBindings: false,
			miniflare: {
				bindings: {
					AUTH_URL: "http://localhost:8787",
					AUTH_SECRET: "test-only-secret-that-is-at-least-32-characters",
					GITHUB_CLIENT_ID: "test-client-id",
					GITHUB_CLIENT_SECRET: "test-client-secret",
					GOOGLE_CLIENT_ID: "test-google-client-id",
					GOOGLE_CLIENT_SECRET: "test-google-client-secret",
					GITHUB_APP_ID: "123",
					GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
					// Background work, such as a push's authority check, signs with the test App key.
					GITHUB_APP_PRIVATE_KEY: privateKey,
					// A test-only key pair from scripts/vapid.ts.
					VAPID_PUBLIC_KEY:
						"BFh5yJqSEBLDPtwYUindkvfE7r9Hm6c8xTT3EZnAo6EfvJLAWHX-HKbq2h83IbBtOvzzDbYp2DwDyqqO-_Uoq_k",
					VAPID_PRIVATE_KEY: "JEYbUlDOII0-TzHqoZrz-7lCBGijto6dcqOFWnLs09o",
					TEST_MIGRATIONS: await readD1Migrations("./migrations"),
				},
			},
		})),
	],
	// Each test file otherwise starts its own workerd and re-imports the whole Worker
	// (the pool appends `import main` to cloudflare:test), all transformed by vitest's
	// one Node process, which also answers a module resolve for every SELF.fetch.
	// One shared runtime imports the Worker once, so a busy host can't stall the tests.
	// test/setup.ts resets storage before each test, and every run shuffles files and
	// tests, so a test that depends on another's leftovers fails (rerun with the
	// printed seed: `vitest run --sequence.seed=<seed>`).
	test: {
		setupFiles: ["./test/setup.ts"],
		fileParallelism: false,
		isolate: false,
		sequence: { shuffle: true },
	},
});
