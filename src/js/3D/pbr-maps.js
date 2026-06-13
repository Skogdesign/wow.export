/*!
	wow.export (https://github.com/Kruithne/wow.export)
	Authors: Kruithne <kruithne@gmail.com>
	License: MIT
 */

// Procedurally derive PBR maps (tangent-space normal + packed ORM) from a
// diffuse/albedo image. WoW art is hand-painted diffuse only — these maps are
// SYNTHETIC approximations (luminance treated as a heightfield) that add
// plausible surface relief and roughness/occlusion for look-dev, relighting and
// glTF PBR export. They are not authored Blizzard data.
//
// All functions operate on plain { data: Uint8ClampedArray|Uint8Array (RGBA),
// width, height } objects so the module stays free of DOM/GL and is unit-testable.

const DEFAULTS = {
	normalStrength: 2.5,   // height->slope gain for the normal map
	roughnessBase: 0.7,    // baseline roughness
	roughnessVariation: 0.3, // how much luminance shifts roughness
	aoStrength: 0.5        // how strongly dark areas read as occluded
};

function clamp(v, lo, hi) {
	return v < lo ? lo : (v > hi ? hi : v);
}

function luminance(r, g, b) {
	return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/**
 * Build a tangent-space normal map from the diffuse luminance via a Sobel
 * gradient. Output is RGBA with the standard (0.5,0.5,1) flat encoding.
 * @param {{data:Uint8ClampedArray, width:number, height:number}} diffuse
 * @param {object} [opts]
 * @returns {{data:Uint8ClampedArray, width:number, height:number}}
 */
function generate_normal_map(diffuse, opts = {}) {
	const { data, width, height } = diffuse;
	const strength = opts.normalStrength ?? DEFAULTS.normalStrength;

	// precompute a height field from luminance
	const h = new Float32Array(width * height);
	for (let i = 0; i < width * height; i++)
		h[i] = luminance(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);

	const at = (x, y) => h[clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)];
	const out = new Uint8ClampedArray(width * height * 4);

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
			const l = at(x - 1, y), r = at(x + 1, y);
			const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);

			const gx = (tr + 2 * r + br) - (tl + 2 * l + bl);
			const gy = (bl + 2 * b + br) - (tl + 2 * t + tr);

			let nx = -gx * strength;
			let ny = -gy * strength;
			let nz = 1.0;
			const len = Math.hypot(nx, ny, nz) || 1;
			nx /= len; ny /= len; nz /= len;

			const o = (y * width + x) * 4;
			out[o] = (nx * 0.5 + 0.5) * 255;
			out[o + 1] = (ny * 0.5 + 0.5) * 255;
			out[o + 2] = (nz * 0.5 + 0.5) * 255;
			out[o + 3] = 255;
		}
	}

	return { data: out, width, height };
}

/**
 * Build a packed ORM map (R = ambient occlusion, G = roughness, B = metallic).
 * Roughness is a base value nudged by luminance; AO is a cheap cavity proxy that
 * darkens already-dark painted areas; metallic is left at 0 (WoW is non-metal).
 * @param {{data:Uint8ClampedArray, width:number, height:number}} diffuse
 * @param {object} [opts]
 * @returns {{data:Uint8ClampedArray, width:number, height:number}}
 */
function generate_orm_map(diffuse, opts = {}) {
	const { data, width, height } = diffuse;
	const base = opts.roughnessBase ?? DEFAULTS.roughnessBase;
	const variation = opts.roughnessVariation ?? DEFAULTS.roughnessVariation;
	const ao_strength = opts.aoStrength ?? DEFAULTS.aoStrength;

	const out = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		const lum = luminance(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);

		// darker (matte) areas read slightly rougher; bright highlights smoother
		const rough = clamp(base + (0.5 - lum) * variation, 0.04, 1.0);
		const ao = clamp(1 - (1 - lum) * ao_strength, 0, 1);

		const o = i * 4;
		out[o] = ao * 255;      // occlusion
		out[o + 1] = rough * 255; // roughness
		out[o + 2] = 0;         // metallic
		out[o + 3] = 255;
	}

	return { data: out, width, height };
}

/**
 * Convenience: produce both maps in one call.
 * @param {{data:Uint8ClampedArray, width:number, height:number}} diffuse
 * @param {object} [opts]
 * @returns {{normal:object, orm:object}}
 */
function generate_pbr_maps(diffuse, opts = {}) {
	return {
		normal: generate_normal_map(diffuse, opts),
		orm: generate_orm_map(diffuse, opts)
	};
}

module.exports = { generate_normal_map, generate_orm_map, generate_pbr_maps, DEFAULTS };
