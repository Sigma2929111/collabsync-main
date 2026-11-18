"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const pluginSource = fs.readFileSync(path.join(__dirname, "..", "main"), "utf8");

test("plugin applies remote reparenting updates", () => {
    const updateStart = pluginSource.indexOf('if delta.kind == "update" then');
    const deleteStart = pluginSource.indexOf('elseif delta.kind == "delete" then', updateStart);
    assert.notEqual(updateStart, -1, "update delta handler must exist");
    assert.notEqual(deleteStart, -1, "delete delta handler must follow update handler");
    const updateHandler = pluginSource.slice(updateStart, deleteStart);
    assert.match(updateHandler, /type\(delta\.parentId\) == "string"/);
    assert.match(updateHandler, /State\.objectMap\[delta\.parentId\]/);
    assert.match(updateHandler, /inst\.Parent = parent/);
    assert.match(updateHandler, /SetAttribute\("_CS_ParentId", delta\.parentId\)/);
});

test("owner review diff includes object name, parent and attributes", () => {
    const reviewStart = pluginSource.indexOf("showReviewPrompt = function(snapshotItems, historyItems)");
    const reviewEnd = pluginSource.indexOf("round(InPlace", reviewStart);
    assert.notEqual(reviewStart, -1, "owner review handler must exist");
    assert.notEqual(reviewEnd, -1, "owner review handler must have a following UI section");
    const reviewHandler = pluginSource.slice(reviewStart, reviewEnd);
    assert.match(reviewHandler, /delta\.name/);
    assert.match(reviewHandler, /delta\.parentId/);
    assert.match(reviewHandler, /delta\.attrs/);
    assert.match(reviewHandler, /delta\.props/);
});
