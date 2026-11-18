"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { detectRadminIPv4, isLoopbackAddress } = require("../radmin-network");

test("prefers an adapter explicitly named Radmin VPN", () => {
    const result = detectRadminIPv4({
        Ethernet: [{family:"IPv4", address:"192.168.1.20", internal:false}],
        "Radmin VPN": [{family:"IPv4", address:"26.15.20.30", internal:false}],
    });
    assert.equal(result.name, "Radmin VPN");
    assert.equal(result.address, "26.15.20.30");
});

test("recognizes Radmin 26/8 address when adapter name is generic", () => {
    const result = detectRadminIPv4({
        "Unknown Adapter": [{family:"IPv4", address:"26.1.2.3", internal:false}],
        Loopback: [{family:"IPv4", address:"127.0.0.1", internal:true}],
    });
    assert.equal(result.address, "26.1.2.3");
});

test("ignores ordinary and internal interfaces", () => {
    const result = detectRadminIPv4({
        Ethernet: [{family:"IPv4", address:"192.168.1.20", internal:false}],
        Loopback: [{family:"IPv4", address:"127.0.0.1", internal:true}],
    });
    assert.equal(result, null);
});

test("identifies loopback clients and rejects non-loopback addresses", () => {
    assert.equal(isLoopbackAddress("127.0.0.1"), true);
    assert.equal(isLoopbackAddress("::1"), true);
    assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
    assert.equal(isLoopbackAddress("26.1.2.3"), false);
    assert.equal(isLoopbackAddress("192.168.1.20"), false);
});
