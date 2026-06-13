/*!
	wow.export (https://github.com/Kruithne/wow.export)
	Authors: Kruithne <kruithne@gmail.com>
	License: MIT
 */

// build-snapshots holds the currently-active "filter by patch" set: the
// FileDataIDs added in the selected patch. The set is computed in build-fetch
// (by diffing a patch against the patch before it) and stored here so the
// listbox can test membership while filtering.

let active = null; // Set<number> of FileDataIDs in the active patch filter, or null when off.

/**
 * Arm the filter with a set of FileDataIDs.
 * @param {Set<number>} set
 */
const set_active = (set) => {
	active = set;
};

/**
 * Disable the filter.
 */
const clear = () => {
	active = null;
};

/**
 * Whether a patch filter is currently armed.
 * @returns {boolean}
 */
const is_active = () => active !== null;

/**
 * Whether a FileDataID is part of the active set.
 * Returns true when the filter is off so callers can use it unconditionally.
 * @param {number} fileDataID
 * @returns {boolean}
 */
const is_added = (fileDataID) => active === null || active.has(fileDataID);

module.exports = { set_active, clear, is_active, is_added };
