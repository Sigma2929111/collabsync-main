"use strict";

const DEFAULT_PERMISSIONS = Object.freeze({ edit: true, delete: true, move: true, add: true, chat: true, camera: true, select: true });

function normalizePermissions(input, fallback = DEFAULT_PERMISSIONS) {
    const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    return {
        edit: typeof source.edit === "boolean" ? source.edit : fallback.edit === true,
        delete: typeof source.delete === "boolean" ? source.delete : fallback.delete === true,
        move: typeof source.move === "boolean" ? source.move : fallback.move === true,
        add: typeof source.add === "boolean" ? source.add : fallback.add === true,
        chat: typeof source.chat === "boolean" ? source.chat : fallback.chat === true,
        camera: typeof source.camera === "boolean" ? source.camera : fallback.camera === true,
        select: typeof source.select === "boolean" ? source.select : fallback.select === true,
    };
}

function canApplyDelta(permissions, delta) {
    const p = normalizePermissions(permissions);
    if (!delta || typeof delta !== "object") return false;
    if (delta.kind === "create") return p.add;
    if (delta.kind === "delete") return p.delete;
    if (delta.kind === "update") {
        const props = delta.props && typeof delta.props === "object" && !Array.isArray(delta.props) ? delta.props : {};
        const keys = Object.keys(props);
        const movementKeys = new Set(["cframe", "position", "worldpivot", "pivotoffset"]);
        const hasMove = delta.parentId !== undefined || keys.some(key => movementKeys.has(key.toLowerCase()));
        const hasOtherEdit = keys.some(key => !movementKeys.has(key.toLowerCase()));
        if (hasMove && !p.move) return false;
        if (hasOtherEdit && !p.edit) return false;
        return hasMove || hasOtherEdit;
    }
    if (delta.kind === "select") return p.select;
    if (delta.kind === "camera") return p.camera;
    return false;
}

module.exports = { DEFAULT_PERMISSIONS, normalizePermissions, canApplyDelta };
