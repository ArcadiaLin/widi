import { describe, expect, it } from "vitest";
import { BackgroundJobOutput } from "../../src/core/background-job.ts";

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
});
