/*!
	wow.export (https://github.com/Kruithne/wow.export)
	Authors: Kruithne <kruithne@gmail.com>
	License: MIT
 */

// CPU particle simulator for a single M2 particle emitter.
//
// The simulation runs in *model space* (the same GL-converted space the bone
// matrices operate in): an emitter is attached to a bone, so each spawned
// particle is seeded using that bone's animated matrix and then integrated with
// gravity/drag independent of the viewer's model transform. Billboarding into
// world space happens at draw time in getRenderQuads(). Keeping the simulator
// free of GL state lets the exporter reuse it for a static snapshot.

const MAX_PARTICLES = 2000;        // hard cap per emitter
const FLOATS_PER_VERTEX = 9;       // position(3) + uv(2) + color(4)
const VERTS_PER_PARTICLE = 6;      // two triangles

// transform a model-space point by a column-major mat4
function transform_point(m, x, y, z, out) {
	out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
	out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
	out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
}

// transform a direction by a column-major mat4 (ignores translation)
function transform_dir(m, x, y, z, out) {
	out[0] = m[0] * x + m[4] * y + m[8] * z;
	out[1] = m[1] * x + m[5] * y + m[9] * z;
	out[2] = m[2] * x + m[6] * y + m[10] * z;
}

function lerp(a, b, t) {
	return a + (b - a) * t;
}

/**
 * Sample a particle "fast" track (FBlock) by a particle's normalized age. The
 * FBlock timestamps run over the particle's lifetime; we normalize against the
 * final timestamp so any timestamp scale works.
 * @param {{timestamps:Array, values:Array}} track
 * @param {number} frac - 0..1 normalized particle age
 * @param {*} def - default value (number or array)
 */
function sample_fblock(track, frac, def) {
	const ts = track && track.timestamps;
	const vals = track && track.values;
	if (!ts || ts.length === 0)
		return def;

	if (ts.length === 1)
		return vals[0];

	const last = ts[ts.length - 1] || 1;
	const t = frac * last;

	if (t <= ts[0])
		return vals[0];
	if (t >= last)
		return vals[ts.length - 1];

	let i = 0;
	while (i < ts.length - 1 && ts[i + 1] < t)
		i++;

	const t0 = ts[i], t1 = ts[i + 1];
	const a = t1 > t0 ? (t - t0) / (t1 - t0) : 0;

	const v0 = vals[i], v1 = vals[i + 1];
	if (Array.isArray(v0)) {
		const out = new Array(v0.length);
		for (let k = 0; k < v0.length; k++)
			out[k] = lerp(v0[k], v1[k], a);
		return out;
	}

	return lerp(v0, v1, a);
}

class ParticleEmitter {
	/**
	 * @param {object} emitter - parsed M2 particle emitter (see M2Loader)
	 */
	constructor(emitter) {
		this.emitter = emitter;

		// live particle pool (struct-of-fields kept on plain objects for clarity;
		// counts are small and bounded by MAX_PARTICLES).
		this.particles = [];
		this._emit_accumulator = 0;

		// texture sheet tiling
		this.cols = Math.max(1, emitter.textureDimensionsColumns | 0);
		this.rows = Math.max(1, emitter.textureDimensionsRows | 0);

		// resolved blend/texture for the renderer to bind. When the multi-texture
		// flag (0x10000000) is set the `texture` field packs three 5-bit texture
		// indices; otherwise it is a direct index into the model's texture list.
		// v1 uses the first packed texture.
		this.blendingType = emitter.blendingType;
		const multiTexture = (emitter.flags & 0x10000000) !== 0;
		this.textureIndex = multiTexture ? (emitter.texture & 0x1F) : emitter.texture;

		// scratch
		this._v0 = new Float32Array(3);
		this._v1 = new Float32Array(3);
		this._vertex_data = null;
	}

	/**
	 * Advance the simulation.
	 * @param {number} delta - seconds
	 * @param {(track:object, def:number)=>number} sample - evaluates an emitter
	 *        M2Track at the current animation time (provided by the renderer)
	 * @param {Float32Array} bone_matrix - model-space matrix for the emitter bone
	 */
	update(delta, sample, bone_matrix) {
		if (delta <= 0)
			return;

		// clamp pathological frame gaps so a stalled tab doesn't dump a huge burst
		if (delta > 0.1)
			delta = 0.1;

		const e = this.emitter;
		const particles = this.particles;

		const gravity = sample(e.gravity, 0);
		const drag_scalar = e.drag || 0; // drag is a plain scalar field, not a track

		// integrate existing particles
		const damping = Math.max(0, 1 - drag_scalar * delta);
		for (let i = particles.length - 1; i >= 0; i--) {
			const p = particles[i];
			p.age += delta;
			if (p.age >= p.lifespan) {
				// swap-remove
				particles[i] = particles[particles.length - 1];
				particles.pop();
				continue;
			}

			p.vy -= gravity * delta;
			p.vx *= damping;
			p.vy *= damping;
			p.vz *= damping;

			p.x += p.vx * delta;
			p.y += p.vy * delta;
			p.z += p.vz * delta;
		}

		// emission gating: enabledIn marks whether the emitter is active in the
		// current animation; treat missing data as "on".
		const enabled = sample(e.enabledIn, 1) > 0;
		const rate = enabled ? Math.max(0, sample(e.emissionRate, 0)) : 0;

		this._emit_accumulator += rate * delta;
		let to_emit = Math.floor(this._emit_accumulator);
		this._emit_accumulator -= to_emit;

		if (to_emit > 0 && bone_matrix) {
			const speed = sample(e.emissionSpeed, 0);
			const speed_var = sample(e.speedVariation, 0);
			const vert_range = sample(e.verticalRange, 0);
			const horiz_range = sample(e.horizontalRange, 0);
			const area_len = sample(e.emissionAreaLength, 0);
			const area_wid = sample(e.emissionAreaWidth, 0);
			const life = sample(e.lifespan, 0);
			const life_vary = e.lifespanVary || 0;

			// emitter origin + local basis in model space (Y is model "up")
			const origin = this._v0;
			transform_point(bone_matrix, e.position[0], e.position[1], e.position[2], origin);

			const sphere = e.emitterType === 2;

			for (let n = 0; n < to_emit && particles.length < MAX_PARTICLES; n++) {
				const lifespan = Math.max(0.05, life * (1 + life_vary * (Math.random() * 2 - 1)));

				// direction within a cone about local +Y (model up)
				const az = sphere ? Math.random() * Math.PI * 2 : (Math.random() * 2 - 1) * (horiz_range || Math.PI);
				const zen = (vert_range || 0) * Math.random();
				const sz = Math.sin(zen), cz = Math.cos(zen);
				const dlx = sz * Math.cos(az);
				const dly = cz;
				const dlz = sz * Math.sin(az);

				const dir = this._v1;
				transform_dir(bone_matrix, dlx, dly, dlz, dir);

				// normalize direction
				let dl = Math.hypot(dir[0], dir[1], dir[2]) || 1;

				const sp = speed * (1 + speed_var * (Math.random() * 2 - 1));

				// plane emitters spread the spawn point over an area on the local
				// X/Z plane; sphere emitters spawn from the origin.
				let ox = 0, oy = 0, oz = 0;
				if (!sphere && (area_len || area_wid)) {
					const lx = (Math.random() * 2 - 1) * area_len * 0.5;
					const lz = (Math.random() * 2 - 1) * area_wid * 0.5;
					const off = [0, 0, 0];
					transform_dir(bone_matrix, lx, 0, lz, off);
					ox = off[0]; oy = off[1]; oz = off[2];
				}

				particles.push({
					x: origin[0] + ox, y: origin[1] + oy, z: origin[2] + oz,
					vx: (dir[0] / dl) * sp,
					vy: (dir[1] / dl) * sp,
					vz: (dir[2] / dl) * sp,
					age: 0,
					lifespan,
					rot: Math.random() * Math.PI * 2
				});
			}
		}
	}

	/** Number of live particles. */
	get count() {
		return this.particles.length;
	}

	/**
	 * Build interleaved billboarded quad vertices for the live particles.
	 * @param {number[]} cam_right - world-space camera right vector
	 * @param {number[]} cam_up - world-space camera up vector
	 * @param {Float32Array} model_matrix - model->world transform
	 * @returns {Float32Array|null} interleaved (pos3, uv2, rgba4) * 6 per particle
	 */
	getRenderQuads(cam_right, cam_up, model_matrix) {
		const particles = this.particles;
		if (particles.length === 0)
			return null;

		const needed = particles.length * VERTS_PER_PARTICLE * FLOATS_PER_VERTEX;
		if (!this._vertex_data || this._vertex_data.length < needed)
			this._vertex_data = new Float32Array(needed);

		const out = this._vertex_data;
		const center = this._v0;
		let o = 0;

		const e = this.emitter;
		for (let i = 0; i < particles.length; i++) {
			const p = particles[i];
			const frac = p.lifespan > 0 ? Math.min(p.age / p.lifespan, 1) : 0;

			// appearance over lifetime
			const col = sample_fblock(e.colorTrack, frac, [1, 1, 1]);
			let r = col[0], g = col[1], b = col[2];
			// guard against 0..255 encoded colour tables
			if (r > 2 || g > 2 || b > 2) { r /= 255; g /= 255; b /= 255; }

			const alpha = Math.min(1, Math.max(0, sample_fblock(e.alphaTrack, frac, 32767) / 32767));
			const scale = sample_fblock(e.scaleTrack, frac, [1, 1]);
			const hw = (scale[0] || 1) * 0.5;
			const hh = (scale[1] || scale[0] || 1) * 0.5;

			// uv tile (flipbook cell)
			let u0 = 0, v0 = 0, du = 1, dv = 1;
			if (this.cols > 1 || this.rows > 1) {
				const cell = sample_fblock(e.headCellTrack, frac, 0) | 0;
				const cx = cell % this.cols;
				const cy = (Math.floor(cell / this.cols)) % this.rows;
				du = 1 / this.cols; dv = 1 / this.rows;
				u0 = cx * du; v0 = cy * dv;
			}

			// world-space center
			transform_point(model_matrix, p.x, p.y, p.z, center);
			const cx = center[0], cy = center[1], cz = center[2];

			const rx = cam_right[0], ry = cam_right[1], rz = cam_right[2];
			const ux = cam_up[0], uy = cam_up[1], uz = cam_up[2];

			// four corners
			const blx = cx - rx * hw - ux * hh, bly = cy - ry * hw - uy * hh, blz = cz - rz * hw - uz * hh;
			const brx = cx + rx * hw - ux * hh, bry = cy + ry * hw - uy * hh, brz = cz + rz * hw - uz * hh;
			const tlx = cx - rx * hw + ux * hh, tly = cy - ry * hw + uy * hh, tlz = cz - rz * hw + uz * hh;
			const trx = cx + rx * hw + ux * hh, try_ = cy + ry * hw + uy * hh, trz = cz + rz * hw + uz * hh;

			o = this._emit_vertex(out, o, blx, bly, blz, u0, v0 + dv, r, g, b, alpha);
			o = this._emit_vertex(out, o, brx, bry, brz, u0 + du, v0 + dv, r, g, b, alpha);
			o = this._emit_vertex(out, o, trx, try_, trz, u0 + du, v0, r, g, b, alpha);

			o = this._emit_vertex(out, o, blx, bly, blz, u0, v0 + dv, r, g, b, alpha);
			o = this._emit_vertex(out, o, trx, try_, trz, u0 + du, v0, r, g, b, alpha);
			o = this._emit_vertex(out, o, tlx, tly, tlz, u0, v0, r, g, b, alpha);
		}

		return out.subarray(0, o);
	}

	_emit_vertex(out, o, x, y, z, u, v, r, g, b, a) {
		out[o++] = x; out[o++] = y; out[o++] = z;
		out[o++] = u; out[o++] = v;
		out[o++] = r; out[o++] = g; out[o++] = b; out[o++] = a;
		return o;
	}

	/** Clear all live particles. */
	reset() {
		this.particles.length = 0;
		this._emit_accumulator = 0;
	}
}

module.exports = ParticleEmitter;
module.exports.MAX_PARTICLES = MAX_PARTICLES;
module.exports.FLOATS_PER_VERTEX = FLOATS_PER_VERTEX;
