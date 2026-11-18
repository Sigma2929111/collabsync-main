"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const root = path.resolve(__dirname, "..");
const secret = "test-secret-for-collabsync-ci-only-0123456789";

async function freePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function waitForHealth(url, child) {
    let lastError = null;
    for (let i = 0; i < 60; i++) {
        if (child.exitCode !== null) throw new Error("server exited before becoming healthy");
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(500) });
            if (response.ok) return;
        } catch (error) { lastError = error; }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("server did not become healthy: " + String(lastError));
}

async function runDiscoveryTest(script, port, extraEnv = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "collabsync-radmin-test-"));
    const child = spawn(process.execPath, [path.join(root, script)], {
        cwd: root,
        env: {
            ...process.env,
            PORT: String(port),
            JWT_SECRET: secret,
            ADMIN_SECRET: secret + "-admin",
            COLLABSYNC_DATA_DIR: dataDir,
            ...extraEnv,
        },
        stdio: "ignore",
    });
    try {
        const base = "http://127.0.0.1:" + port;
        await waitForHealth(base + "/health", child);
        const response = await fetch(base + "/network-info", { signal: AbortSignal.timeout(2000) });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.ok, true);
        assert.equal(body.port, port);
        assert.ok(body.radminIp === null || typeof body.radminIp === "string");
        assert.ok(body.adapter === null || typeof body.adapter === "string");

        // The adapter inventory must not be readable from another local interface.
        const nonLoopback = Object.values(os.networkInterfaces()).flat().find(
            entry => entry && entry.family === "IPv4" && !entry.internal
        );
        if (nonLoopback) {
            const externalResponse = await fetch("http://" + nonLoopback.address + ":" + port + "/network-info", {
                signal: AbortSignal.timeout(2000),
            });
            assert.equal(externalResponse.status, 403);
        }
    } finally {
        child.kill("SIGTERM");
        await new Promise(resolve => {
            if (child.exitCode !== null) return resolve();
            child.once("exit", resolve);
            setTimeout(resolve, 1500).unref();
        });
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
}

test("separate Server 2 exposes loopback-only Radmin discovery", async () => {
    await runDiscoveryTest("server 2", await freePort());
});

test("Server 2-in-1 exposes loopback-only Radmin discovery", async () => {
    await runDiscoveryTest("server 2 in 1", await freePort());
});
