"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizePermissions, canApplyDelta } = require("../permissions");

test("permissions default to allow for compatibility and normalize explicit booleans", () => {
    assert.deepEqual(normalizePermissions(null), {edit:true, delete:true, move:true, add:true, chat:true, camera:true, select:true});
    assert.deepEqual(normalizePermissions({edit:false, add:false}), {edit:false, delete:true, move:true, add:false, chat:true, camera:true, select:true});
});

test("create, delete, property edits and movement require their matching permission", () => {
    const none = {edit:false, delete:false, move:false, add:false};
    assert.equal(canApplyDelta(none, {kind:"create"}), false);
    assert.equal(canApplyDelta(none, {kind:"delete"}), false);
    assert.equal(canApplyDelta(none, {kind:"update", props:{Name:"x"}}), false);
    assert.equal(canApplyDelta(none, {kind:"update", props:{CFrame:[0]}}), false);
    assert.equal(canApplyDelta(none, {kind:"update", parentId:"folder"}), false);
    assert.equal(canApplyDelta(none, {kind:"select"}), true);
    assert.equal(canApplyDelta(none, {kind:"camera"}), true);
    assert.equal(canApplyDelta(none, {kind:"select"}), true);
});

test("movement and property edits are independently controlled", () => {
    assert.equal(canApplyDelta({edit:true, move:false, add:true, delete:true}, {kind:"update", props:{CFrame:[0]}}), false);
    assert.equal(canApplyDelta({edit:false, move:true, add:true, delete:true}, {kind:"update", props:{Name:"Renamed"}}), false);
    assert.equal(canApplyDelta({edit:true, move:false}, {kind:"update", props:{Name:"Renamed"}}), true);
    assert.equal(canApplyDelta({edit:false, move:true}, {kind:"update", props:{Position:[1,2,3]}}), true);
});
test("chat, camera and selection permissions are independently enforced", () => {
    const none = {chat:false, camera:false, select:false};
    assert.equal(normalizePermissions(none).chat, false);
    assert.equal(canApplyDelta(none, {kind:"camera", cframe:Array(12).fill(0)}), false);
    assert.equal(canApplyDelta(none, {kind:"select", id:"part"}), false);
    assert.equal(canApplyDelta({camera:true, select:false}, {kind:"camera"}), true);
    assert.equal(canApplyDelta({camera:false, select:true}, {kind:"select"}), true);
});
