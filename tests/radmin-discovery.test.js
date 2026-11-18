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

async function startNodeServer(script, port, dataDir, extraEnv = {}) {
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
            ...extraEnv,
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
        const deniedNotice = waitForMessage(guestSocket, message => message.type === "permission_denied" && message.action === "update", 4000, "edit permission denial notice");
        guestSocket.send(JSON.stringify({type:"delta", id:"acl-denied", kind:"update", props:{Name:"blocked"}}));
        await deniedNotice;
        assert.equal(await deniedDelta, false, "server must reject an update without edit permission");
        const readOnlyLock = waitForMessage(hostSocket, message => message.type === "lock_state" && message.objectId === "read-only-lock", 250).then(() => true, () => false);
        const readOnlyLockNotice = waitForMessage(guestSocket, message => message.type === "permission_denied" && message.action === "lock", 4000, "read-only lock denial notice");
        guestSocket.send(JSON.stringify({type:"lock_request", objectId:"read-only-lock"}));
        await readOnlyLockNotice;
        assert.equal(await readOnlyLock, false, "a participant with no mutation permissions must not lock objects");

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

        // A participant cannot grant themselves permissions by sending the owner-only control message.
        guestSocket.send(JSON.stringify({
            type:"permissions_update", targetUserId:120002,
            permissions:{edit:true, delete:true, move:true, add:true},
        }));
        const deniedKinds = [
            {id:"acl-delete-denied", kind:"delete"},
            {id:"acl-move-denied", kind:"update", props:{Position:{x:1,y:2,z:3}}},
            {id:"acl-parent-denied", kind:"update", parentId:"service:ServerStorage", props:{}},
            {id:"acl-create-denied", kind:"create", name:"blocked", className:"Part", parentId:"service:Workspace", props:{Name:"blocked"}},
        ];
        for (const candidate of deniedKinds) {
            const leaked = waitForMessage(hostSocket, message => message.type === "delta" && message.id === candidate.id, 250)
                .then(() => true, () => false);
            guestSocket.send(JSON.stringify({type:"delta", ...candidate}));
            assert.equal(await leaked, false, "server must enforce delete/move/add permissions and ignore guest permission escalation");
        }

        const grantRemaining = waitForMessage(guestSocket, message =>
            message.type === "players" && message.players.some(p => p.userId === 120002 &&
                p.permissions?.delete === true && p.permissions?.move === true && p.permissions?.add === true)
        , 4000, "grant remaining permissions");
        hostSocket.send(JSON.stringify({
            type:"permissions_update", targetUserId:120002,
            permissions:{edit:true, delete:true, move:true, add:true},
        }));
        await grantRemaining;
        for (const candidate of [
            {id:"acl-move-allowed", kind:"update", props:{Position:{x:4,y:5,z:6}}},
            {id:"acl-parent-allowed", kind:"update", parentId:"service:ServerStorage", props:{}},
            {id:"acl-delete-allowed", kind:"delete"},
            {id:"acl-create-allowed", kind:"create", name:"allowed", className:"Part", parentId:"service:Workspace", props:{Name:"allowed"}},
        ]) {
            const received = waitForMessage(hostSocket, message => message.type === "delta" && message.id === candidate.id, 4000, "permitted "+candidate.kind+" delta");
            guestSocket.send(JSON.stringify({type:"delta", ...candidate}));
            assert.equal((await received).userId, 120002);
        }

        const hostLock = waitForMessage(guestSocket, message => message.type === "lock_state" && message.objectId === "locked-edit" && message.lock?.userId === 120001, 4000, "host object lock broadcast");
        hostSocket.send(JSON.stringify({type:"lock_request", objectId:"locked-edit"}));
        await hostLock;
        const lockConflict = waitForMessage(guestSocket, message => message.type === "lock_conflict" && message.objectId === "locked-edit", 4000, "guest lock conflict");
        guestSocket.send(JSON.stringify({type:"lock_request", objectId:"locked-edit"}));
        await lockConflict;
        const spoofedLockBypass = waitForMessage(hostSocket, message => message.type === "delta" && message.id === "locked-edit", 250)
            .then(() => true, () => false);
        guestSocket.send(JSON.stringify({type:"delta", id:"locked-edit", objectId:"unlocked-spoof", kind:"update", props:{Name:"must not bypass lock"}}));
        assert.equal(await spoofedLockBypass, false, "server must derive lock target from the actual delta id, not a client-supplied alias");
        const blockedByLock = waitForMessage(hostSocket, message => message.type === "delta" && message.id === "locked-edit", 250)
            .then(() => true, () => false);
        guestSocket.send(JSON.stringify({type:"delta", id:"locked-edit", objectId:"locked-edit", kind:"update", props:{Name:"must not pass lock"}}));
        assert.equal(await blockedByLock, false, "server must reject edits while another participant holds the object lock");
        const unauthorizedRelease = waitForMessage(guestSocket, message => message.type === "lock_state" && message.objectId === "locked-edit" && message.lock === null, 250)
            .then(() => true, () => false);
        guestSocket.send(JSON.stringify({type:"lock_release", objectId:"locked-edit"}));
        assert.equal(await unauthorizedRelease, false, "a participant must not release another participant's lock");
        const unlocked = waitForMessage(guestSocket, message => message.type === "lock_state" && message.objectId === "locked-edit" && message.lock === null, 4000, "lock release broadcast");
        hostSocket.send(JSON.stringify({type:"lock_release", objectId:"locked-edit"}));
        await unlocked;
        const afterUnlock = waitForMessage(hostSocket, message => message.type === "delta" && message.id === "locked-edit", 4000, "edit after lock release");
        guestSocket.send(JSON.stringify({type:"delta", id:"locked-edit", objectId:"locked-edit", kind:"update", props:{Name:"allowed after unlock"}}));
        assert.equal((await afterUnlock).userId, 120002);

        const guestOwnedLock = waitForMessage(hostSocket, message => message.type === "lock_state" && message.objectId === "guest-disconnect-lock" && message.lock?.userId === 120002, 4000, "guest-owned lock");
        guestSocket.send(JSON.stringify({type:"lock_request", objectId:"guest-disconnect-lock"}));
        await guestOwnedLock;
        const releasedOnDisconnect = waitForMessage(hostSocket, message => message.type === "lock_state" && message.objectId === "guest-disconnect-lock" && message.lock === null, 4000, "split lock release after disconnect");
        guestSocket.close();
        await releasedOnDisconnect;
        guestSocket = null;
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

        const unauthorizedBackup = await fetch(base + "/api/workspace/backups/create", {
            method:"POST",
            headers:{"Content-Type":"application/json", "Authorization":"Bearer "+guestJoin.token},
            body:JSON.stringify({lobbyId:created.lobbyId}),
        });
        assert.equal(unauthorizedBackup.status, 403, "non-owner must not create workspace backups");
        const unauthorizedRestore = await fetch(base + "/api/workspace/backups/restore", {
            method:"POST",
            headers:{"Content-Type":"application/json", "Authorization":"Bearer "+guestJoin.token},
            body:JSON.stringify({lobbyId:created.lobbyId, backupId:backupData.backup.id}),
        });
        assert.equal(unauthorizedRestore.status, 403, "non-owner must not restore workspace backups");

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
        const backupHeaders = {"Content-Type":"application/json", "Authorization":"Bearer "+created.token};
        const backupCreateBeforeRestart = await fetch(hostUrl + "/api/workspace/backups/create", {
            method:"POST", headers:backupHeaders, body:JSON.stringify({lobbyId:created.lobbyId}),
        });
        assert.equal(backupCreateBeforeRestart.status, 200);
        const persistedBackup = await backupCreateBeforeRestart.json();
        hostSocket.send(JSON.stringify({type:"delta", id:"split-history-event", objectId:"split-object", kind:"update", props:{Name:"Changed before restart"}}));
        hostSocket.send(JSON.stringify({type:"snapshot", data:[{...snapshot[0], name:"Changed after backup", props:{Name:"Changed after backup"}}]}));
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
        const backupHeadersAfterRestart = {"Content-Type":"application/json", "Authorization":"Bearer "+ownerJoin.token};
        const restoreResponse = await fetch(hostUrl + "/api/workspace/backups/restore", {
            method:"POST", headers:backupHeadersAfterRestart,
            body:JSON.stringify({lobbyId:created.lobbyId, backupId:persistedBackup.backup.id}),
        });
        assert.equal(restoreResponse.status, 200);
        const restored = await restoreResponse.json();
        assert.equal(restored.snapshotSize, 1);
        const backupListResponse = await fetch(hostUrl + "/api/workspace/"+created.lobbyId+"/backups", {headers:backupHeadersAfterRestart});
        assert.equal(backupListResponse.status, 200);
        const splitBackupList = await backupListResponse.json();
        assert.ok(splitBackupList.backups.some(item => item.id === persistedBackup.backup.id), "backup must survive Server 2 restart");
        assert.ok(splitBackupList.backups.some(item => item.reason === "pre-restore"), "restore must create a safety backup before replacing the snapshot");
        const activityResponse = await fetch(hostUrl + "/api/workspace/"+created.lobbyId+"/activity", {headers:backupHeadersAfterRestart});
        assert.equal(activityResponse.status, 200);
        const splitActivity = await activityResponse.json();
        assert.ok(splitActivity.activity.some(item => item.id === "split-history-event"), "activity log must survive Server 2 restart");
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


test("Server 2-in-1 enforces member ACL and object claims", async () => {
    const port = await freePort();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "collabsync-combined-acl-"));
    const baseUrl = "http://127.0.0.1:" + port;
    let server, hostSocket, guestSocket, testerSocket, newcomerSocket;
    try {
        server = await startNodeServer("server 2 in 1", port, dataDir, {TESTER_IDS:"150003"});
        const createResponse = await fetch(baseUrl + "/api/lobby/create", {
            method:"POST", headers:{"Content-Type":"application/json"},
            body:JSON.stringify({name:"Combined ACL CI", hostId:150001, hostName:"Combined Owner", persistent:true}),
        });
        assert.equal(createResponse.status, 200);
        const created = await createResponse.json();
        hostSocket = (await connectWs(baseUrl, created.token)).socket;

        const joinResponse = await fetch(baseUrl + "/api/lobby/join", {
            method:"POST", headers:{"Content-Type":"application/json"},
            body:JSON.stringify({lobbyId:created.lobbyId, userId:150002, userName:"Combined Guest"}),
        });
        assert.equal(joinResponse.status, 200);
        const joined = await joinResponse.json();
        guestSocket = (await connectWs(baseUrl, joined.token)).socket;

        const testerJoinResponse = await fetch(baseUrl + "/api/lobby/join", {
            method:"POST", headers:{"Content-Type":"application/json"},
            body:JSON.stringify({lobbyId:created.lobbyId, userId:150003, userName:"Read Only Tester"}),
        });
        assert.equal(testerJoinResponse.status, 200);
        const testerJoined = await testerJoinResponse.json();
        testerSocket = (await connectWs(baseUrl, testerJoined.token)).socket;
        const testerEdit = waitForMessage(hostSocket, m => m.type === "delta" && m.id === "tester-edit", 250).then(() => true, () => false);
        const testerEditNotice = waitForMessage(testerSocket, m => m.type === "permission_denied" && m.action === "update", 4000, "tester edit denial notice");
        testerSocket.send(JSON.stringify({type:"delta", id:"tester-edit", kind:"update", props:{Name:"must remain read only"}}));
        await testerEditNotice;
        assert.equal(await testerEdit, false, "tester must not edit the shared workspace");
        const testerLock = waitForMessage(hostSocket, m => m.type === "lock_state" && m.objectId === "tester-object", 250).then(() => true, () => false);
        const testerLockNotice = waitForMessage(testerSocket, m => m.type === "permission_denied" && m.action === "lock", 4000, "tester lock denial notice");
        testerSocket.send(JSON.stringify({type:"lock_request", objectId:"tester-object"}));
        await testerLockNotice;
        assert.equal(await testerLock, false, "tester must not claim editable object locks");

        const denyNotice = waitForMessage(guestSocket, m => m.type === "players" && m.players.some(p => p.userId === 150002 && p.permissions?.edit === false), 4000, "combined ACL deny notice");
        hostSocket.send(JSON.stringify({type:"permissions_update", targetUserId:150002, permissions:{edit:false, delete:false, move:false, add:false}}));
        await denyNotice;
        const denied = waitForMessage(hostSocket, m => m.type === "delta" && m.objectId === "combined-object", 250).then(() => true, () => false);
        guestSocket.send(JSON.stringify({type:"delta", id:"combined-event-1", objectId:"combined-object", kind:"update", props:{Name:"blocked"}}));
        assert.equal(await denied, false, "combined server must reject denied property edits");
        const readOnlyLock = waitForMessage(hostSocket, m => m.type === "lock_state" && m.objectId === "combined-read-only-lock", 250).then(() => true, () => false);
        guestSocket.send(JSON.stringify({type:"lock_request", objectId:"combined-read-only-lock"}));
        assert.equal(await readOnlyLock, false, "combined server must not let read-only members lock objects");

        const allowNotice = waitForMessage(guestSocket, m => m.type === "players" && m.players.some(p => p.userId === 150002 && p.permissions?.edit === true), 4000, "combined ACL allow notice");
        hostSocket.send(JSON.stringify({type:"permissions_update", targetUserId:150002, permissions:{edit:true, delete:false, move:false, add:false}}));
        await allowNotice;
        const allowed = waitForMessage(hostSocket, m => m.type === "delta" && m.id === "combined-event-2", 4000, "combined allowed edit");
        guestSocket.send(JSON.stringify({type:"delta", id:"combined-event-2", objectId:"combined-object", kind:"update", props:{Name:"allowed"}}));
        assert.equal((await allowed).userId, 150002);

        const guestLock = waitForMessage(hostSocket, m => m.type === "lock_state" && m.objectId === "revoked-lock" && m.lock?.userId === 150002, 4000, "guest lock before permission revocation");
        guestSocket.send(JSON.stringify({type:"lock_request", objectId:"revoked-lock"}));
        await guestLock;
        const lockReleased = waitForMessage(hostSocket, m => m.type === "lock_state" && m.objectId === "revoked-lock" && m.lock === null, 4000, "revoked member lock release");
        const revokedNotice = waitForMessage(guestSocket, m => m.type === "players" && m.players.some(p => p.userId === 150002 && p.permissions?.edit === false && p.permissions?.delete === false && p.permissions?.move === false && p.permissions?.add === false), 4000, "member permissions revoked");
        hostSocket.send(JSON.stringify({type:"permissions_update", targetUserId:150002, permissions:{edit:false, delete:false, move:false, add:false}}));
        await Promise.all([lockReleased, revokedNotice]);
        const regrantNotice = waitForMessage(guestSocket, m => m.type === "players" && m.players.some(p => p.userId === 150002 && p.permissions?.edit === true && p.permissions?.delete === true && p.permissions?.move === true && p.permissions?.add === true), 4000, "member permissions restored");
        hostSocket.send(JSON.stringify({type:"permissions_update", targetUserId:150002, permissions:{edit:true, delete:true, move:true, add:true}}));
        await regrantNotice;

        const disablePresence = waitForMessage(guestSocket, m => m.type === "players" && m.players.some(p => p.userId === 150002 && p.permissions?.chat === false && p.permissions?.camera === false && p.permissions?.select === false), 4000, "disable chat and presence");
        hostSocket.send(JSON.stringify({type:"permissions_update", targetUserId:150002, permissions:{edit:true, delete:true, move:true, add:true, chat:false, camera:false, select:false}}));
        await disablePresence;
        guestSocket.send(JSON.stringify({type:"permissions_update", targetUserId:150002, permissions:{edit:true, delete:true, move:true, add:true, chat:true, camera:true, select:true}}));
        const blockedChat = waitForMessage(hostSocket, m => m.type === "chat" && m.userId === 150002, 250).then(() => true, () => false);
        const chatDeniedNotice = waitForMessage(guestSocket, m => m.type === "permission_denied" && m.action === "chat", 4000, "chat permission denial notice");
        guestSocket.send(JSON.stringify({type:"chat", text:"must not be delivered"}));
        await chatDeniedNotice;
        assert.equal(await blockedChat, false, "server must enforce chat permission");
        const blockedCamera = waitForMessage(hostSocket, m => m.type === "delta" && m.kind === "camera", 250).then(() => true, () => false);
        const cameraDeniedNotice = waitForMessage(guestSocket, m => m.type === "permission_denied" && m.action === "camera", 4000, "camera permission denial notice");
        guestSocket.send(JSON.stringify({type:"delta", id:"camera-disabled", kind:"camera", cframe:Array(12).fill(0)}));
        await cameraDeniedNotice;
        assert.equal(await blockedCamera, false, "server must enforce camera permission");
        const blockedSelection = waitForMessage(hostSocket, m => m.type === "delta" && m.kind === "select" && m.id === "selection-disabled", 250).then(() => true, () => false);
        const selectionDeniedNotice = waitForMessage(guestSocket, m => m.type === "permission_denied" && m.action === "select", 4000, "selection permission denial notice");
        guestSocket.send(JSON.stringify({type:"delta", id:"selection-disabled", kind:"select", active:true}));
        await selectionDeniedNotice;
        assert.equal(await blockedSelection, false, "server must enforce selection permission");

        const restorePresence = waitForMessage(guestSocket, m => m.type === "players" && m.players.some(p => p.userId === 150002 && p.permissions?.chat === true && p.permissions?.camera === true && p.permissions?.select === true), 4000, "restore chat and presence");
        hostSocket.send(JSON.stringify({type:"permissions_update", targetUserId:150002, permissions:{edit:true, delete:true, move:true, add:true, chat:true, camera:true, select:true}}));
        await restorePresence;

        const lockState = waitForMessage(guestSocket, m => m.type === "lock_state" && m.objectId === "combined-object" && m.lock?.userId === 150001, 4000, "combined lock state");
        hostSocket.send(JSON.stringify({type:"lock_request", objectId:"combined-object"}));
        await lockState;

        const newcomerJoin = await fetch(baseUrl + "/api/lobby/join", {
            method:"POST", headers:{"Content-Type":"application/json"},
            body:JSON.stringify({lobbyId:created.lobbyId, userId:150004, userName:"Late Joiner"}),
        });
        assert.equal(newcomerJoin.status, 200);
        const newcomerToken = await newcomerJoin.json();
        newcomerSocket = new WebSocket(baseUrl.replace("http:", "ws:") + "/ws");
        const newcomerWelcome = waitForMessage(newcomerSocket, m => m.type === "welcome", 4000, "late joiner welcome");
        const newcomerLock = waitForMessage(newcomerSocket, m => m.type === "lock_state" && m.objectId === "combined-object" && m.lock?.userId === 150001, 4000, "late joiner receives active lock");
        await new Promise((resolve, reject) => {
            newcomerSocket.once("error", reject);
            newcomerSocket.once("open", resolve);
        });
        newcomerSocket.send(JSON.stringify({type:"hello", token:newcomerToken.token}));
        await newcomerWelcome;
        await newcomerLock;

        const conflict = waitForMessage(guestSocket, m => m.type === "lock_conflict" && m.objectId === "combined-object", 4000, "combined lock conflict");
        guestSocket.send(JSON.stringify({type:"lock_request", objectId:"combined-object"}));
        await conflict;
        const spoofedDelta = waitForMessage(hostSocket, m => m.type === "delta" && m.id === "combined-object", 250).then(() => true, () => false);
        guestSocket.send(JSON.stringify({type:"delta", id:"combined-object", objectId:"unlocked-spoof", kind:"update", props:{Name:"blocked by actual object lock"}}));
        assert.equal(await spoofedDelta, false, "combined server must enforce the lock for the actual delta target");

        const disconnectLock = waitForMessage(hostSocket, m => m.type === "lock_state" && m.objectId === "disconnect-lock" && m.lock?.userId === 150002, 4000, "guest lock before disconnect");
        guestSocket.send(JSON.stringify({type:"lock_request", objectId:"disconnect-lock"}));
        await disconnectLock;
        const releasedOnDisconnect = waitForMessage(hostSocket, m => m.type === "lock_state" && m.objectId === "disconnect-lock" && m.lock === null, 4000, "lock release after guest disconnect");
        guestSocket.close();
        await releasedOnDisconnect;
        guestSocket = null;
    } finally {
        for (const socket of [hostSocket, guestSocket, testerSocket, newcomerSocket]) {
            if (socket && socket.readyState !== WebSocket.CLOSED) socket.close();
        }
        await stopNodeServer(server);
        fs.rmSync(dataDir, {recursive:true, force:true});
    }
});
