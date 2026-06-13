class M2Track {
	/**
	 * Construct a new M2Track instance.
	 * @param {number} globalSeq
	 * @param {number} interpolation
	 * @param {Array} timestamps
	 * @param {Array} values
	 * @param {Array} timestampOffsets - array of {count, offset} per animation
	 * @param {Array} valueOffsets - array of {count, offset} per animation
	 */
	constructor(globalSeq, interpolation, timestamps, values, timestampOffsets = null, valueOffsets = null) {
		this.globalSeq = globalSeq;
		this.interpolation = interpolation;
		this.timestamps = timestamps;
		this.values = values;
		this.timestampOffsets = timestampOffsets;
		this.valueOffsets = valueOffsets;
	}
}

// See https://wowdev.wiki/M2#Standard_animation_block
function read_m2_array_array(data, ofs, dataType, useAnims = false, animFiles = new Map(), storeOffsets = false, sequences = null) {
	const arrCount = data.readUInt32LE();
	const arrOfs = data.readUInt32LE();

	const base = data.offset;
	data.seek(ofs + arrOfs);

	const arr = Array(arrCount);
	const offsets = storeOffsets ? Array(arrCount) : null;

	for (let i = 0; i < arrCount; i++) {
		const subArrCount = data.readUInt32LE();
		const subArrOfs = data.readUInt32LE();
		const subBase = data.offset;

		if (storeOffsets)
			offsets[i] = { count: subArrCount, offset: subArrOfs };

		// data lives in external .anim file, skip reading from M2 buffer
		if (sequences && i < sequences.length && (sequences[i].flags & 0x20) === 0) {
			arr[i] = [];
			data.seek(subBase);
			continue;
		}

		data.seek(ofs + subArrOfs);

		arr[i] = Array(subArrCount);
		for (let j = 0; j < subArrCount; j++) {
			if (useAnims && animFiles.has(i)) {
				switch (dataType) {
					case 'uint32':
						animFiles.get(i).seek(subArrOfs + (j * 4));
						arr[i][j] = animFiles.get(i).readUInt32LE();
						break;
					case 'int16':
						animFiles.get(i).seek(subArrOfs + (j * 2));
						arr[i][j] = animFiles.get(i).readInt16LE();
						break;
					case 'float':
						animFiles.get(i).seek(subArrOfs + (j * 4));
						arr[i][j] = animFiles.get(i).readFloatLE();
						break;
					case 'float2':
						animFiles.get(i).seek(subArrOfs + (j * 8));
						arr[i][j] = animFiles.get(i).readFloatLE(2);
						break;
					case 'float3':
						animFiles.get(i).seek(subArrOfs + (j * 12));
						arr[i][j] = animFiles.get(i).readFloatLE(3);
						break;
					case 'float4':
						animFiles.get(i).seek(subArrOfs + (j * 16));
						arr[i][j] = animFiles.get(i).readFloatLE(4);
						break;
					case 'compquat':
						animFiles.get(i).seek(subArrOfs + (j * 8));
						arr[i][j] = animFiles.get(i).readUInt16LE(4).map(e => (e - 32767) / 32768);
						break;
					case 'uint8':
						animFiles.get(i).seek(subArrOfs + j);
						arr[i][j] = animFiles.get(i).readUInt8();
						break;
					default:
						throw new Error(`Unhandled data type: ${dataType}`);
				}
			} else {
				switch (dataType) {
					case 'uint32':
						arr[i][j] = data.readUInt32LE();
						break;
					case 'int16':
						arr[i][j] = data.readInt16LE();
						break;
					case 'float':
						arr[i][j] = data.readFloatLE();
						break;
					case 'float2':
						arr[i][j] = data.readFloatLE(2);
						break;
					case 'float3':
						arr[i][j] = data.readFloatLE(3);
						break;
					case 'float4':
						arr[i][j] = data.readFloatLE(4);
						break;
					case 'compquat':
						arr[i][j] = data.readUInt16LE(4).map(e => (e - 32767) / 32768);
						break;
					case 'uint8':
						arr[i][j] = data.readUInt8();
						break;
					default:
						throw new Error(`Unknown data type: ${dataType}`);
				}
			}
		}

		data.seek(subBase);
	}

	data.seek(base);

	if (storeOffsets)
		return { arr, offsets };

	return arr;
}

// See https://wowdev.wiki/M2#Standard_animation_block
function read_m2_track(data, ofs, dataType, useAnims = false, animFiles = new Map(), storeOffsets = false, sequences = null) {
	const interpolation = data.readUInt16LE();
	const globalSeq = data.readUInt16LE();

	let timestamps, values;
	let timestampOffsets = null, valueOffsets = null;

	if (useAnims) {
		timestamps = read_m2_array_array(data, ofs, 'uint32', useAnims, animFiles, false, sequences);
		values = read_m2_array_array(data, ofs, dataType, useAnims, animFiles, false, sequences);
	} else if (storeOffsets) {
		const tsResult = read_m2_array_array(data, ofs, 'uint32', false, animFiles, true, sequences);
		timestamps = tsResult.arr;
		timestampOffsets = tsResult.offsets;

		const valResult = read_m2_array_array(data, ofs, dataType, false, animFiles, true, sequences);
		values = valResult.arr;
		valueOffsets = valResult.offsets;
	} else {
		timestamps = read_m2_array_array(data, ofs, 'uint32', false, new Map(), false, sequences);
		values = read_m2_array_array(data, ofs, dataType, false, new Map(), false, sequences);
	}

	return new M2Track(globalSeq, interpolation, timestamps, values, timestampOffsets, valueOffsets);
}

/**
 * Patch a single animation slot in a track using external .anim data.
 * @param {M2Track} track
 * @param {number} animIndex
 * @param {BufferWrapper} animBuffer
 * @param {string} valueType
 */
function patch_track_animation(track, animIndex, animBuffer, valueType) {
	if (!track.timestampOffsets || !track.valueOffsets)
		return;

	if (animIndex >= track.timestampOffsets.length)
		return;

	const tsInfo = track.timestampOffsets[animIndex];
	const valInfo = track.valueOffsets[animIndex];

	// bounds check: ensure offsets fit within the .anim buffer
	const VALUE_SIZES = { uint32: 4, int16: 2, float3: 12, float4: 16, compquat: 8, uint8: 1 };
	const valElemSize = VALUE_SIZES[valueType] ?? 0;
	const tsEnd = tsInfo.offset + tsInfo.count * 4;
	const valEnd = valInfo.offset + valInfo.count * valElemSize;

	if (tsEnd > animBuffer.byteLength || valEnd > animBuffer.byteLength)
		return;

	// read timestamps from .anim buffer
	const timestamps = Array(tsInfo.count);
	for (let j = 0; j < tsInfo.count; j++) {
		animBuffer.seek(tsInfo.offset + (j * 4));
		timestamps[j] = animBuffer.readUInt32LE();
	}
	track.timestamps[animIndex] = timestamps;

	// read values from .anim buffer
	const values = Array(valInfo.count);
	for (let j = 0; j < valInfo.count; j++) {
		switch (valueType) {
			case 'float3':
				animBuffer.seek(valInfo.offset + (j * 12));
				values[j] = animBuffer.readFloatLE(3);
				break;
			case 'compquat':
				animBuffer.seek(valInfo.offset + (j * 8));
				values[j] = animBuffer.readUInt16LE(4).map(e => (e - 32767) / 32768);
				break;
			case 'float4':
				animBuffer.seek(valInfo.offset + (j * 16));
				values[j] = animBuffer.readFloatLE(4);
				break;
			case 'int16':
				animBuffer.seek(valInfo.offset + (j * 2));
				values[j] = animBuffer.readInt16LE();
				break;
			case 'uint32':
				animBuffer.seek(valInfo.offset + (j * 4));
				values[j] = animBuffer.readUInt32LE();
				break;
			case 'uint8':
				animBuffer.seek(valInfo.offset + j);
				values[j] = animBuffer.readUInt8();
				break;
		}
	}

	track.values[animIndex] = values;
}

// See https://wowdev.wiki/Common_Types#CAaBox
function read_caa_bb(data) {
	return { min: data.readFloatLE(3), max: data.readFloatLE(3) };
}

/**
 * Read a simple (flat) M2Array<type> and return its values. The cursor is left
 * immediately after the 8-byte array header (count + offset), matching the other
 * readers in this module.
 * @param {BufferWrapper} data
 * @param {number} ofs - base offset the array offset is relative to (MD20 start)
 * @param {string} dataType
 * @returns {Array}
 */
function read_m2_array(data, ofs, dataType) {
	const count = data.readUInt32LE();
	const arrOfs = data.readUInt32LE();

	const base = data.offset;
	data.seek(ofs + arrOfs);

	const arr = new Array(count);
	for (let i = 0; i < count; i++) {
		switch (dataType) {
			case 'uint16': arr[i] = data.readUInt16LE(); break;
			case 'int16': arr[i] = data.readInt16LE(); break;
			case 'float': arr[i] = data.readFloatLE(); break;
			case 'float2': arr[i] = data.readFloatLE(2); break;
			case 'float3': arr[i] = data.readFloatLE(3); break;
			default: throw new Error(`Unknown data type: ${dataType}`);
		}
	}

	data.seek(base);
	return arr;
}

/**
 * Read an M2 particle "fast" track (M2PartTrack / FBlock): a pair of flat M2Arrays
 * holding uint16 timestamps and typed key values. Used for the per-lifetime
 * color/alpha/scale/cell tables of a particle emitter. Consumes a 16-byte header.
 * @param {BufferWrapper} data
 * @param {number} ofs
 * @param {string} valueType
 * @returns {{ timestamps: Array, values: Array }}
 */
function read_fblock(data, ofs, valueType) {
	const timestamps = read_m2_array(data, ofs, 'uint16');
	const values = read_m2_array(data, ofs, valueType);
	return { timestamps, values };
}

module.exports = { M2Track, read_m2_array_array, read_m2_array, read_m2_track, read_fblock, read_caa_bb, patch_track_animation }