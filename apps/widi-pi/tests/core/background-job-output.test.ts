import { describe, expect, it } from "vitest";
import { BackgroundJobOutput } from "../../src/core/background-job.ts";

const base64 = (value: string | Buffer) =>
	Buffer.from(value).toString("base64");

describe("BackgroundJobOutput", () => {
	it("accumulates appended chunks and reads them back as UTF-8", () => {
		const output = new BackgroundJobOutput();
		output.append("hello ");
		output.append(Buffer.from("world"));

		expect(output.read()).toBe("hello world");
	});

	it("returns an empty string before anything is appended", () => {
		expect(new BackgroundJobOutput().read()).toBe("");
	});

	it("ignores empty chunks", () => {
		const output = new BackgroundJobOutput();
		output.append("");
		output.append(Buffer.alloc(0));

		expect(output.read()).toBe("");
	});

	it("keeps exactly the last bytes once over the cap", () => {
		const output = new BackgroundJobOutput(8);
		output.append("aaa");
		output.append("bbb");
		output.append("ccc");

		// Total is 9 bytes over an 8-byte cap; the head is trimmed by one byte so
		// the buffer holds exactly the trailing 8 bytes.
		expect(output.read()).toBe("aabbbccc");
	});

	it("drops fully superseded head chunks", () => {
		const output = new BackgroundJobOutput(4);
		output.append("aaa");
		output.append("bbbb");

		// "bbbb" alone fills the cap, so the whole "aaa" chunk is dropped.
		expect(output.read()).toBe("bbbb");
	});

	it("slices the boundary chunk to keep exactly the last bytes", () => {
		const output = new BackgroundJobOutput(4);
		output.append("abcdefgh");

		// A single chunk larger than the cap is sliced to its trailing 4 bytes.
		expect(output.read()).toBe("efgh");
	});

	it("decodes multi-byte UTF-8 that spans chunk boundaries", () => {
		const output = new BackgroundJobOutput();
		const bytes = Buffer.from("héllo", "utf-8");
		output.append(bytes.subarray(0, 2));
		output.append(bytes.subarray(2));

		expect(output.read()).toBe("héllo");
	});

	it("tracks total bytes seen independent of the rolling tail cap", () => {
		const output = new BackgroundJobOutput(4);
		output.append("aaaa");
		output.append("bbbb");

		expect(output.totalBytesSeen).toBe(8);
		expect(output.tailDroppedBytes).toBe(4);
		expect(output.progressDroppedBytes).toBe(0);
		// The tail only keeps the last 4 bytes, but the total counts everything.
		expect(output.read()).toBe("bbbb");
	});

	it("drains the unforwarded increment with absolute byte offsets", () => {
		const output = new BackgroundJobOutput();
		output.append("hello ");
		output.append("world");

		const first = output.drainIncrement();
		expect(first).toEqual({
			chunk: base64("hello world"),
			startByte: 0,
			endByte: 11,
			totalBytesSeen: 11,
			progressDroppedBytes: 0,
		});

		// A second drain with nothing new appended returns undefined.
		expect(output.drainIncrement()).toBeUndefined();

		output.append("!");
		expect(output.drainIncrement()).toEqual({
			chunk: base64("!"),
			startByte: 11,
			endByte: 12,
			totalBytesSeen: 12,
			progressDroppedBytes: 0,
		});
	});

	it("keeps byte offsets exact when a UTF-8 character spans drains", () => {
		const bytes = Buffer.from("é", "utf-8");
		const output = new BackgroundJobOutput();

		output.append(bytes.subarray(0, 1));
		const first = output.drainIncrement();
		output.append(bytes.subarray(1));
		const second = output.drainIncrement();

		expect(first).toMatchObject({ startByte: 0, endByte: 1 });
		expect(second).toMatchObject({ startByte: 1, endByte: 2 });
		const reconstructed = Buffer.concat(
			[first, second].map((increment) =>
				Buffer.from(increment?.chunk ?? "", "base64"),
			),
		);
		expect(reconstructed).toEqual(bytes);
	});

	it("leaves a detectable gap when the increment buffer overflows", () => {
		// Small increment cap so a burst between drains overflows and drops.
		const output = new BackgroundJobOutput(1024, { incrementMaxBytes: 4 });
		output.append("abcdef");

		const increment = output.drainIncrement();
		// The head two bytes were dropped; startByte jumps past 0 and
		// progressDroppedBytes records the gap, so a consumer can tell the stream
		// is not contiguous.
		expect(increment).toEqual({
			chunk: base64("cdef"),
			startByte: 2,
			endByte: 6,
			totalBytesSeen: 6,
			progressDroppedBytes: 2,
		});
		expect(output.tailDroppedBytes).toBe(0);
		expect(output.progressDroppedBytes).toBe(2);
	});
});
