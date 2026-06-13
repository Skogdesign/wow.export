/*!
	wow.export (https://github.com/Kruithne/wow.export)
	Authors: Kruithne <kruithne@gmail.com>
	License: MIT
 */
const path = require('path');
const fsp = require('fs').promises;
const constants = require('../constants');
const log = require('../log');

// build-snapshots records the set of FileDataIDs present in each build the user
// opens. By diffing the current build's set against a previously-captured one we
// can show only the files that were *added since* that earlier build (the
// "Added since…" filter). Snapshots are stored as a flat sorted Uint32 array of
// FileDataIDs, one file per build, alongside an index.json carrying labels.

let current_ids = null; // Sorted Uint32Array of the currently-loaded build's FileDataIDs.
let active_added = null; // Set<number> of FileDataIDs added since the selected build, or null when the filter is off.

const INDEX_FILE = 'index.json';

/**
 * Turn an arbitrary build name into a safe file name.
 * @param {string} name
 * @returns {string}
 */
const sanitize = (name) => String(name).replace(/[^A-Za-z0-9._-]/g, '_');

/**
 * Binary search a sorted Uint32Array.
 * @param {Uint32Array} arr
 * @param {number} val
 * @returns {boolean}
 */
const contains = (arr, val) => {
	let lo = 0, hi = arr.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >>> 1;
		const v = arr[mid];
		if (v === val)
			return true;

		if (v < val)
			lo = mid + 1;
		else
			hi = mid - 1;
	}

	return false;
};

/**
 * Read and merge the snapshot index.
 * @returns {Promise<object>}
 */
const read_index = async () => {
	try {
		return JSON.parse(await fsp.readFile(path.join(constants.CACHE.DIR_SNAPSHOTS, INDEX_FILE), 'utf8'));
	} catch (e) {
		return {};
	}
};

/**
 * Capture the file set of the currently-loaded build and persist it.
 * @param {string} buildName Human-readable build version (e.g. "12.0.7.xxxxx").
 * @param {Map} rootEntries The active build's root entries (FileDataID keys).
 */
const capture = async (buildName, rootEntries) => {
	// Keep the current set in memory regardless, so diffs work this session.
	const ids = Uint32Array.from(rootEntries.keys());
	ids.sort();
	current_ids = ids;

	if (!buildName)
		return;

	try {
		await fsp.mkdir(constants.CACHE.DIR_SNAPSHOTS, { recursive: true });

		const key = sanitize(buildName);
		const data_path = path.join(constants.CACHE.DIR_SNAPSHOTS, key + '.bin');
		await fsp.writeFile(data_path, Buffer.from(ids.buffer, ids.byteOffset, ids.byteLength));

		const index = await read_index();
		index[key] = { name: buildName, count: ids.length, time: Date.now() };
		await fsp.writeFile(path.join(constants.CACHE.DIR_SNAPSHOTS, INDEX_FILE), JSON.stringify(index));

		log.write('Captured build snapshot %s (%d files)', buildName, ids.length);
	} catch (e) {
		log.write('Failed to capture build snapshot: %s', e.message);
	}
};

/**
 * List captured snapshots other than the supplied current build, newest first.
 * @param {string} currentBuildName
 * @returns {Promise<Array<{name: string, count: number, time: number}>>}
 */
const list = async (currentBuildName) => {
	const index = await read_index();
	const current_key = sanitize(currentBuildName ?? '');
	return Object.entries(index)
		.filter(([key]) => key !== current_key)
		.map(([, meta]) => meta)
		.sort((a, b) => b.time - a.time);
};

/**
 * Compute the set of FileDataIDs added since the given build and arm the filter.
 * @param {string} buildName
 * @returns {Promise<number>} Count of added files.
 */
const compute_added_since = async (buildName) => {
	if (!buildName || current_ids === null) {
		active_added = null;
		return 0;
	}

	try {
		const data_path = path.join(constants.CACHE.DIR_SNAPSHOTS, sanitize(buildName) + '.bin');
		const buf = await fsp.readFile(data_path);
		const old_ids = new Uint32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));

		const added = new Set();
		for (let i = 0; i < current_ids.length; i++) {
			const id = current_ids[i];
			if (!contains(old_ids, id))
				added.add(id);
		}

		active_added = added;
		log.write('Build diff against %s: %d files added', buildName, added.size);
		return added.size;
	} catch (e) {
		log.write('Failed to compute build diff: %s', e.message);
		active_added = null;
		return 0;
	}
};

/**
 * Disable the "added since" filter.
 */
const clear = () => {
	active_added = null;
};

/**
 * Whether the filter is currently armed.
 * @returns {boolean}
 */
const is_active = () => active_added !== null;

/**
 * Whether a FileDataID is part of the active "added since" set.
 * Returns true when the filter is off so callers can use it unconditionally.
 * @param {number} fileDataID
 * @returns {boolean}
 */
const is_added = (fileDataID) => active_added === null || active_added.has(fileDataID);

module.exports = { capture, list, compute_added_since, clear, is_active, is_added };
