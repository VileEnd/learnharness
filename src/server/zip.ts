/**
 * A minimal zip writer on node:zlib (no dependency): each entry is
 * DEFLATE-compressed (deflateRawSync, method 8) with its CRC-32
 * (zlib.crc32), followed by the central directory and the end record.
 * Names are UTF-8 (general-purpose flag bit 11); timestamps are fixed
 * (1980-01-01) so the same files always produce the same bytes. Whole archive
 * in memory: the library is a few MB of text. No zip64 (65535 entries / 4 GiB).
 */

import { crc32, deflateRawSync } from "node:zlib";
import type { OkfFile } from "../core/contracts/okf.ts";

const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1; // 1980-01-01
const UTF8 = 1 << 11;

export function zipFiles(files: OkfFile[]): Buffer {
	if (files.length > 0xffff) throw new Error("too many files for a zip without zip64");
	const chunks: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const file of files) {
		const name = Buffer.from(file.path, "utf-8");
		const data = Buffer.from(file.content, "utf-8");
		const packed = deflateRawSync(data);
		const crc = crc32(data);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4); // version needed
		local.writeUInt16LE(UTF8, 6);
		local.writeUInt16LE(8, 8); // deflate
		local.writeUInt16LE(DOS_TIME, 10);
		local.writeUInt16LE(DOS_DATE, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(packed.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28);
		chunks.push(local, name, packed);

		const entry = Buffer.alloc(46);
		entry.writeUInt32LE(0x02014b50, 0);
		entry.writeUInt16LE(20, 4); // version made by
		entry.writeUInt16LE(20, 6); // version needed
		entry.writeUInt16LE(UTF8, 8);
		entry.writeUInt16LE(8, 10);
		entry.writeUInt16LE(DOS_TIME, 12);
		entry.writeUInt16LE(DOS_DATE, 14);
		entry.writeUInt32LE(crc, 16);
		entry.writeUInt32LE(packed.length, 20);
		entry.writeUInt32LE(data.length, 24);
		entry.writeUInt16LE(name.length, 28);
		// extra, comment, disk, internal/external attrs stay 0
		entry.writeUInt32LE(offset, 42);
		central.push(entry, name);

		offset += local.length + name.length + packed.length;
	}
	const centralSize = central.reduce((n, b) => n + b.length, 0);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(files.length, 8);
	end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(centralSize, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...chunks, ...central, end]);
}
