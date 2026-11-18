"use strict";

const os = require("os");

function detectRadminIPv4(networkInterfaces = os.networkInterfaces()) {
    const candidates = [];
    for (const [name, entries] of Object.entries(networkInterfaces || {})) {
        for (const entry of entries || []) {
            if ((entry.family !== "IPv4" && entry.family !== 4) || entry.internal) continue;
            const address = String(entry.address || "");
            const radminName = /radmin/i.test(name);
            const vpnName = /vpn/i.test(name);
            const radminRange = /^26\./.test(address);
            if (!radminName && !vpnName && !radminRange) continue;
            candidates.push({
                name,
                address,
                score: radminName ? 4 : (radminRange ? 3 : 2),
            });
        }
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0] || null;
}

function isLoopbackAddress(address) {
    const normalized = String(address || "").replace(/^::ffff:/, "");
    return normalized === "127.0.0.1" || normalized === "::1";
}

function isLoopbackRequest(req) {
    return isLoopbackAddress(req && req.socket && req.socket.remoteAddress);
}

module.exports = { detectRadminIPv4, isLoopbackAddress, isLoopbackRequest };
