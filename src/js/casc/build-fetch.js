/*!
	wow.export (https://github.com/Kruithne/wow.export)
	Authors: Kruithne <kruithne@gmail.com>
	License: MIT
 */
const path = require('path');
const fsp = require('fs').promises;
const generics = require('../generics');
const constants = require('../constants');
const log = require('../log');
const CASC = require('./casc-source');

// build-fetch retrieves the complete FileDataID set (root) of an arbitrary
// build directly from a CDN mirror, without loading it as the active source.
// This powers the "Added in patch X" filter for patches the user never opened.
// "Added in patch X" = the files present in patch X but not in the patch before
// it, intersected (at filter time) with the build the user currently has open.

// archive.wow.tools mirrors the full data tier for historical builds that have
// been purged from Blizzard's live CDN.
const CDN_BASE = 'https://archive.wow.tools/tpr/wow/';
const BUILDS_API = 'https://wago.tools/api/builds';

// Format a content/encoding key into its CDN path component (xx/yy/<key>).
const fmt_key = (key) => key.substring(0, 2) + '/' + key.substring(2, 4) + '/' + key;

// In-memory cache of fetched id sets, keyed by build-config hash.
const id_cache = new Map();

/**
 * Fetch the sorted FileDataID array for a build, by build-config hash.
 * Cached in memory and on disk so each build is only downloaded once.
 * @param {string} buildConfigHash
 * @param {function} [onProgress] Optional progress callback (0-1).
 * @returns {Promise<Uint32Array>} Sorted FileDataIDs.
 */
const fetch_build_ids = async (buildConfigHash, onProgress) => {
	if (id_cache.has(buildConfigHash))
		return id_cache.get(buildConfigHash);

	// Disk cache.
	const cache_file = path.join(constants.CACHE.DIR_SNAPSHOTS, 'bc_' + buildConfigHash + '.bin');
	try {
		const buf = await fsp.readFile(cache_file);
		const ids = new Uint32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
		id_cache.set(buildConfigHash, ids);
		return ids;
	} catch (e) {
		// Not cached; fetch below.
	}

	onProgress?.(0.05);

	// 1. Build config (plain text) → root content key + encoding keys.
	const res = await generics.get(CDN_BASE + 'config/' + fmt_key(buildConfigHash));
	if (!res.ok)
		throw new Error('build config unavailable (HTTP ' + res.status + ')');

	const cfg = await res.text();
	const root_ckey = (cfg.match(/^root = (\w+)/m) || [])[1];
	const enc_match = cfg.match(/^encoding = (\w+) (\w+)/m);
	if (!root_ckey || !enc_match)
		throw new Error('failed to parse build config');

	const enc_ekey = enc_match[2];
	const holder = { rootTypes: [], rootEntries: new Map(), encodingKeys: new Map(), encodingSizes: new Map(), unhookConfig: () => {} };

	// 2. Encoding table → content-key → encoding-key map.
	onProgress?.(0.1);
	const enc_data = await generics.downloadFile(CDN_BASE + 'data/' + fmt_key(enc_ekey));
	await CASC.prototype.parseEncodingFile.call(holder, enc_data, enc_ekey);

	const root_ekey = holder.encodingKeys.get(root_ckey);
	if (!root_ekey)
		throw new Error('root key not present in encoding table');

	// 3. Root file → FileDataID set.
	onProgress?.(0.6);
	const root_data = await generics.downloadFile(CDN_BASE + 'data/' + fmt_key(root_ekey));
	await CASC.prototype.parseRootFile.call(holder, root_data, root_ekey);

	const ids = Uint32Array.from(holder.rootEntries.keys());
	ids.sort();

	onProgress?.(0.95);
	try {
		await fsp.mkdir(constants.CACHE.DIR_SNAPSHOTS, { recursive: true });
		await fsp.writeFile(cache_file, Buffer.from(ids.buffer, ids.byteOffset, ids.byteLength));
	} catch (e) {
		log.write('[build-fetch] failed to cache build ids: %s', e.message);
	}

	id_cache.set(buildConfigHash, ids);
	log.write('[build-fetch] fetched %d files for build-config %s', ids.length, buildConfigHash);
	return ids;
};

/**
 * Fetch the list of WoW patches from wago.tools, newest first, each with the
 * build-config of its latest build and the build before it (for diffing).
 * @returns {Promise<Array<{patch: string, version: string, buildConfig: string, prevConfig: string|null}>>}
 */
const get_patch_list = async () => {
	const res = await generics.get(BUILDS_API);
	if (!res.ok)
		throw new Error('could not fetch build list (HTTP ' + res.status + ')');

	const data = await res.json();
	const builds = data.wow || [];

	// builds are newest-first; keep the first (latest) build seen per patch.
	const patches = [];
	const seen = new Set();
	for (const b of builds) {
		const m = String(b.version).match(/^(\d+\.\d+)/);
		if (!m || !b.build_config)
			continue;

		const patch = m[1];
		if (seen.has(patch))
			continue;

		seen.add(patch);
		patches.push({ patch, version: b.version, buildConfig: b.build_config });
	}

	// "previous patch" = the next entry in the newest-first list.
	for (let i = 0; i < patches.length; i++)
		patches[i].prevConfig = patches[i + 1]?.buildConfig ?? null;

	return patches;
};

/**
 * Compute the set of FileDataIDs added IN a patch (present in the patch but not
 * in the patch before it).
 * @param {object} patch A patch entry from get_patch_list().
 * @param {function} [onProgress]
 * @returns {Promise<Set<number>>}
 */
const compute_added_in_patch = async (patch, onProgress) => {
	if (!patch.prevConfig)
		throw new Error('no earlier patch to compare against');

	const cur = await fetch_build_ids(patch.buildConfig, p => onProgress?.(p * 0.5));
	const prev = await fetch_build_ids(patch.prevConfig, p => onProgress?.(0.5 + p * 0.5));

	// Binary-search membership against the (sorted) previous patch.
	const contains = (arr, val) => {
		let lo = 0, hi = arr.length - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >>> 1;
			if (arr[mid] === val) return true;
			if (arr[mid] < val) lo = mid + 1; else hi = mid - 1;
		}
		return false;
	};

	const added = new Set();
	for (let i = 0; i < cur.length; i++) {
		if (!contains(prev, cur[i]))
			added.add(cur[i]);
	}

	log.write('[build-fetch] patch %s added %d files vs prior patch', patch.patch, added.size);
	return added;
};

module.exports = { fetch_build_ids, get_patch_list, compute_added_in_patch };
