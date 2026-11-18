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
test("plugin exposes chat camera and selection permission controls", () => {
    assert.match(pluginSource, /"Редакт\.", "Удалять", "Двигать", "Добавлять", "Чат", "Камера", "Выбор"/);
    assert.match(pluginSource, /chat=selected\[5\], camera=selected\[6\], select=selected\[7\]/);
    assert.match(pluginSource, /permissions\.chat == true, permissions\.camera == true, permissions\.select == true/);
});
test("plugin displays server-side permission denial feedback", () => {
    assert.match(pluginSource, /data\.type == "permission_denied"/);
    assert.match(pluginSource, /Недостаточно прав/);
});
test("owner review rows show all detected fields with expandable row height", () => {
    assert.match(pluginSource, /table\.concat\(changes, "; "\)/);
    assert.match(pluginSource, /math\.ceil\(#description \/ 100\)/);
    assert.match(pluginSource, /math\.min\(260, math\.max\(58,/);
});
