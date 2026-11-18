"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const WebSocket = require("ws");

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


function waitForMessage(socket, predicate, timeoutMs = 4000, label = "matching message") {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            clearTimeout(timer);
            socket.off("message", onMessage);
            socket.off("close", onClose);
        };
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error("WebSocket message timeout: " + label));
        }, timeoutMs);
        function onClose() {
            cleanup();
            reject(new Error("WebSocket closed before " + label));
        }
        function onMessage(raw) {
            let message;
            try { message = JSON.parse(raw.toString()); } catch (_) { return; }
            if (message && message.type === "error") {
                cleanup();
                reject(new Error("Server rejected " + label + ": " + String(message.message || "unknown error")));
                return;
            }
            if (!predicate(message)) return;
            cleanup();
            resolve(message);
        }
        socket.on("message", onMessage);
        socket.once("close", onClose);
    });
}

async function startNodeServer(script, port, dataDir) {
    const child = spawn(process.execPath, [path.join(root, script)], {
        cwd: root,
        env: {
            ...process.env,
            PORT: String(port),
            JWT_SECRET: secret,
            ADMIN_SECRET: secret + "-admin",
            CATALOG_PUBLIC_URL: "",
            HOST_PUBLIC_URL: "",
            COLLABSYNC_DATA_DIR: dataDir,
        },
        stdio: "ignore",
    });
    await waitForHealth("http://127.0.0.1:" + port + "/health", child);
    return child;
}

test("Server 1 and Server 2 support a real two-client collaboration session", async () => {
    const catalogPort = await freePort();
    const hostPort = await freePort();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "collabsync-two-client-"));
    let catalog, host, hostSocket, guestSocket;
    try {
        catalog = await startNodeServer("server 1", catalogPort, dataDir);
        host = await startNodeServer("server 2", hostPort, dataDir);
        const catalogUrl = "http://127.0.0.1:" + catalogPort;
        const hostUrl = "http://127.0.0.1:" + hostPort;

        const createdResponse = await fetch(catalogUrl + "/api/lobby/create", {
            method: "POST",
            headers: {"Content-Type":"application/json"},
            body: JSON.stringify({
                name: "CI two-client test",
                hostId: 120001,
                hostName: "CI Host",
                hostUrl,
                placeId: 1,
                placeName: "CI Place",
            }),
        });
        assert.equal(createdResponse.status, 200);
        const created = await createdResponse.json();
        assert.ok(created.lobbyId && created.token);

        const hostReady = new Promise((resolve, reject) => {
            hostSocket = new WebSocket(hostUrl.replace("http://", "ws://") + "/ws");
            hostSocket.once("error", reject);
            hostSocket.on("open", () => hostSocket.send(JSON.stringify({type:"hello", token:created.token})));
            waitForMessage(hostSocket, message => message.type === "welcome").then(resolve, reject);
        });
        const hostWelcome = await hostReady;
        assert.equal(hostWelcome.lobbyId, created.lobbyId);

        const joinedResponse = await fetch(catalogUrl + "/api/lobby/join", {
            method: "POST",
            headers: {"Content-Type":"application/json"},
            body: JSON.stringify({
                lobbyId: created.lobbyId,
                userId: 120002,
                userName: "CI Guest",
            }),
        });
        assert.equal(joinedResponse.status, 200);
        const joined = await joinedResponse.json();
        assert.ok(joined.token);

        const guestReady = new Promise((resolve, reject) => {
            guestSocket = new WebSocket(hostUrl.replace("http://", "ws://") + "/ws");
            guestSocket.once("error", reject);
            guestSocket.on("open", () => guestSocket.send(JSON.stringify({type:"hello", token:joined.token})));
            waitForMessage(guestSocket, message => message.type === "welcome").then(resolve, reject);
        });
        const guestWelcome = await guestReady;
        assert.equal(guestWelcome.lobbyId, created.lobbyId);
        assert.equal(guestWelcome.players.length, 2);

        const receivedDelta = waitForMessage(hostSocket, message => message.type === "delta" && message.id === "ci-delta", 4000, "initial guest create delta");
        guestSocket.send(JSON.stringify({
            type:"delta", id:"ci-delta", kind:"create",
            userId:999999, userName:"forged identity",
            name:"CI Part", className:"Part", parentId:"service:Workspace",
            props:{Name:"CI Part"},
        }));
        const delta = await receivedDelta;
        assert.equal(delta.userId, 120002);
        assert.equal(delta.userName, "CI Guest");

        const denyUpdate = waitForMessage(guestSocket, message =>
            message.type === "players" && message.players.some(p => p.userId === 120002 && p.permissions && p.permissions.edit === false)
        , 4000, "guest permission deny broadcast");
        hostSocket.send(JSON.stringify({
            type:"permissions_update", targetUserId:120002,
            permissions:{edit:false, delete:false, move:false, add:false},
        }));
        await denyUpdate;
        const deniedDelta = waitForMessage(hostSocket, message => message.type === "delta" && message.id === "acl-denied", 300)
            .then(() => true, () => false);
        guestSocket.send(JSON.stringify({type:"delta", id:"acl-denied", kind:"update", props:{Name:"blocked"}}));
        assert.equal(await deniedDelta, false, "server must reject an update without edit permission");

        const allowUpdate = waitForMessage(guestSocket, message =>
            message.type === "players" && message.players.some(p => p.userId === 120002 && p.permissions && p.permissions.edit === true)
        , 4000, "guest permission allow broadcast");
        hostSocket.send(JSON.stringify({
            type:"permissions_update", targetUserId:120002,
            permissions:{edit:true, delete:false, move:false, add:false},
        }));
        await allowUpdate;
        const acceptedDelta = waitForMessage(hostSocket, message => message.type === "delta" && message.id === "acl-allowed", 4000, "allowed guest update delta");
        guestSocket.send(JSON.stringify({type:"delta", id:"acl-allowed", kind:"update", props:{Name:"allowed"}}));
        const allowed = await acceptedDelta;
        assert.equal(allowed.userId, 120002);

        const hostLock = waitForMessage(guestSocket, message => message.type === "lock_state" && message.objectId === "locked-edit" && message.lock?.userId === 120001, 4000, "host object lock broadcast");
        hostSocket.send(JSON.stringify({type:"lock_request", objectId:"locked-edit"}));
        await hostLock;
        const lockConflict = waitForMessage(guestSocket, message => message.type === "lock_conflict" && message.objectId === "locked-edit", 4000, "guest lock conflict");
        guestSocket.send(JSON.stringify({type:"lock_request", objectId:"locked-edit"}));
        await lockConflict;
        const blockedByLock = waitForMessage(hostSocket, message => message.type === "delta" && message.id === "locked-edit", 250)
            .then(() => true, () => false);
        guestSocket.send(JSON.stringify({type:"delta", id:"locked-edit", objectId:"locked-edit", kind:"update", props:{Name:"must not pass lock"}}));
        assert.equal(await blockedByLock, false, "server must reject edits while another participant holds the object lock");
        const unlocked = waitForMessage(guestSocket, message => message.type === "lock_state" && message.objectId === "locked-edit" && message.lock === null, 4000, "lock release broadcast");
        hostSocket.send(JSON.stringify({type:"lock_release", objectId:"locked-edit"}));
        await unlocked;
        const afterUnlock = waitForMessage(hostSocket, message => message.type === "delta" && message.id === "locked-edit", 4000, "edit after lock release");
        guestSocket.send(JSON.stringify({type:"delta", id:"locked-edit", objectId:"locked-edit", kind:"update", props:{Name:"allowed after unlock"}}));
        assert.equal((await afterUnlock).userId, 120002);
    } finally {
        for (const socket of [hostSocket, guestSocket]) {
            if (socket && socket.readyState !== WebSocket.CLOSED) socket.close();
        }
        for (const child of [host, catalog]) {
            if (child && child.exitCode === null) child.kill("SIGTERM");
        }
        fs.rmSync(dataDir, { recursive:true, force:true });
    }
});


async function stopNodeServer(child) {
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([
        new Promise(resolve => child.once("exit", resolve)),
        new Promise(resolve => setTimeout(resolve, 8000)),
    ]);
    if (child.exitCode === null) throw new Error("server did not shut down gracefully");
}

async function connectWs(url, token) {
    const socket = new WebSocket(url.replace(/^http:/, "ws:") + "/ws");
    const welcomePromise = waitForMessage(socket, message => message.type === "welcome", 4000, "WebSocket welcome handshake");
    await new Promise((resolve, reject) => {
        socket.once("error", reject);
        socket.once("open", resolve);
    });
    socket.send(JSON.stringify({type:"hello", token}));
    return {socket, welcome: await welcomePromise};
}

test("persistent workspace backup, restore, restart and owner rejoin work end-to-end", async () => {
    const port = await freePort();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "collabsync-persistent-test-"));
    let child, hostSocket, guestSocket;
    const base = "http://127.0.0.1:" + port;
    try {
        child = await startNodeServer("server 2 in 1", port, dataDir);
        const createdResponse = await fetch(base + "/api/lobby/create", {
            method:"POST",
            headers:{"Content-Type":"application/json"},
            body:JSON.stringify({
                name:"CI persistent workspace",
                hostId:130001,
                hostName:"CI Owner",
                persistent:true,
                placeId:1,
                placeName:"Persistent CI Place",
            }),
        });
        assert.equal(createdResponse.status, 200);
        const created = await createdResponse.json();
        assert.equal(created.persistent, true);

        const hostConnection = await connectWs(base, created.token);
        hostSocket = hostConnection.socket;
        const firstSnapshot = [{
            id:"ci-object-1", parentId:"service:Workspace", className:"Part",
            name:"Before backup", props:{Name:"Before backup"}, attrs:{},
        }];
        hostSocket.send(JSON.stringify({type:"snapshot", data:firstSnapshot}));
        await new Promise(resolve => setTimeout(resolve, 400));

        const backupResponse = await fetch(base + "/api/workspace/backups/create", {
            method:"POST",
            headers:{"Content-Type":"application/json", "Authorization":"Bearer "+created.token},
            body:JSON.stringify({lobbyId:created.lobbyId}),
        });
        assert.equal(backupResponse.status, 200);
        const backupData = await backupResponse.json();
        assert.ok(backupData.backup && backupData.backup.id);

        hostSocket.send(JSON.stringify({type:"snapshot", data:[
            ...firstSnapshot,
            {id:"ci-object-2", parentId:"service:Workspace", className:"Part", name:"After backup", props:{Name:"After backup"}, attrs:{}},
        ]}));
        await new Promise(resolve => setTimeout(resolve, 350));

        const restoreResponse = await fetch(base + "/api/workspace/backups/restore", {
            method:"POST",
            headers:{"Content-Type":"application/json", "Authorization":"Bearer "+created.token},
            body:JSON.stringify({lobbyId:created.lobbyId, backupId:backupData.backup.id}),
        });
        assert.equal(restoreResponse.status, 200);
        const restored = await restoreResponse.json();
        assert.equal(restored.snapshotSize, 1);

        await hostSocket.close();
        hostSocket = null;
        await stopNodeServer(child);
        child = null;

        child = await startNodeServer("server 2 in 1", port, dataDir);
        const listResponse = await fetch(base + "/api/lobby/list");
        assert.equal(listResponse.status, 200);
        const listData = await listResponse.json();
        assert.ok(listData.lobbies.some(lobby => lobby.id === created.lobbyId));

        const ownerJoinResponse = await fetch(base + "/api/lobby/join", {
            method:"POST",
            headers:{"Content-Type":"application/json"},
            body:JSON.stringify({lobbyId:created.lobbyId, userId:130001, userName:"CI Owner"}),
        });
        assert.equal(ownerJoinResponse.status, 200);
        const ownerJoin = await ownerJoinResponse.json();
        assert.equal(ownerJoin.isHost, true);
        assert.equal(ownerJoin.persistent, true);

        const guestJoinResponse = await fetch(base + "/api/lobby/join", {
            method:"POST",
            headers:{"Content-Type":"application/json"},
            body:JSON.stringify({lobbyId:created.lobbyId, userId:130002, userName:"CI Guest"}),
        });
        assert.equal(guestJoinResponse.status, 200);
        const guestJoin = await guestJoinResponse.json();
        assert.equal(guestJoin.isHost, false);

        const guestConnection = await connectWs(base, guestJoin.token);
        guestSocket = guestConnection.socket;
        assert.equal(guestConnection.welcome.lobbyId, created.lobbyId);

        const ownerConnection = await connectWs(base, ownerJoin.token);
        hostSocket = ownerConnection.socket;
        assert.equal(ownerConnection.welcome.snapshotSize, 1);

    } finally {
        for (const socket of [hostSocket, guestSocket]) {
            if (socket && socket.readyState !== WebSocket.CLOSED) socket.close();
        }
        await stopNodeServer(child);
        fs.rmSync(dataDir, {recursive:true, force:true});
    }
});


test("split Server 1 + Server 2 persistent workspace survives both service restarts", async () => {
    const catalogPort = await freePort();
    const hostPort = await freePort();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "collabsync-split-persistent-"));
    const catalogUrl = "http://127.0.0.1:" + catalogPort;
    const hostUrl = "http://127.0.0.1:" + hostPort;
    let catalog, host, hostSocket;
    try {
        catalog = await startNodeServer("server 1", catalogPort, dataDir);
        host = await startNodeServer("server 2", hostPort, dataDir);

        const createResponse = await fetch(catalogUrl + "/api/lobby/create", {
            method:"POST",
            headers:{"Content-Type":"application/json"},
            body:JSON.stringify({name:"Split persistent CI", hostId:140001, hostName:"Split Owner", hostUrl, persistent:true}),
        });
        assert.equal(createResponse.status, 200);
        const created = await createResponse.json();
        assert.equal(created.persistent, true);

        const firstConnection = await connectWs(hostUrl, created.token);
        hostSocket = firstConnection.socket;
        const snapshot = [{id:"split-object", parentId:"service:Workspace", className:"Part", name:"Persisted", props:{Name:"Persisted"}, attrs:{}}];
        hostSocket.send(JSON.stringify({type:"snapshot", data:snapshot}));
        await new Promise(resolve => setTimeout(resolve, 450));
        await new Promise(resolve => { hostSocket.once("close", resolve); hostSocket.close(); });
        hostSocket = null;
        await stopNodeServer(host);
        host = null;
        await stopNodeServer(catalog);
        catalog = null;

        catalog = await startNodeServer("server 1", catalogPort, dataDir);
        host = await startNodeServer("server 2", hostPort, dataDir);
        const restoredHealth = await (await fetch(hostUrl + "/health")).json();
        assert.equal(restoredHealth.rooms, 1, "Server 2 must restore the persistent room before owner reconnects");
        const listResponse = await fetch(catalogUrl + "/api/lobby/list");
        assert.equal(listResponse.status, 200);
        const listed = await listResponse.json();
        assert.ok(listed.lobbies.some(item => item.id === created.lobbyId && item.persistent === true));

        const ownerJoinResponse = await fetch(catalogUrl + "/api/lobby/join", {
            method:"POST",
            headers:{"Content-Type":"application/json"},
            body:JSON.stringify({lobbyId:created.lobbyId, userId:140001, userName:"Split Owner"}),
        });
        assert.equal(ownerJoinResponse.status, 200);
        const ownerJoin = await ownerJoinResponse.json();
        assert.equal(ownerJoin.isHost, true);
        assert.equal(ownerJoin.persistent, true);
        const ownerConnection = await connectWs(hostUrl, ownerJoin.token);
        hostSocket = ownerConnection.socket;
        assert.equal(ownerConnection.welcome.snapshotSize, 1);
        const backupHeaders = {"Content-Type":"application/json", "Authorization":"Bearer "+ownerJoin.token};
        const backupCreateResponse = await fetch(hostUrl + "/api/workspace/backups/create", {
            method:"POST", headers:backupHeaders, body:JSON.stringify({lobbyId:created.lobbyId}),
        });
        assert.equal(backupCreateResponse.status, 200);
        const splitBackup = await backupCreateResponse.json();
        assert.ok(splitBackup.backup && splitBackup.backup.id);
        const backupListResponse = await fetch(hostUrl + "/api/workspace/"+created.lobbyId+"/backups", {headers:backupHeaders});
        assert.equal(backupListResponse.status, 200);
        const splitBackupList = await backupListResponse.json();
        assert.ok(splitBackupList.backups.some(item => item.id === splitBackup.backup.id));
        const activityResponse = await fetch(hostUrl + "/api/workspace/"+created.lobbyId+"/activity", {headers:backupHeaders});
        assert.equal(activityResponse.status, 200);
    } finally {
        if (hostSocket && hostSocket.readyState !== WebSocket.CLOSED) {
            await new Promise(resolve => {
                hostSocket.once("close", resolve);
                hostSocket.close();
            });
        }
        await stopNodeServer(host);
        await stopNodeServer(catalog);
        fs.rmSync(dataDir, {recursive:true, force:true});
    }
});
