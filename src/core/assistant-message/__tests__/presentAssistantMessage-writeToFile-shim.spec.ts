import { describe, expect, it } from "vitest"

import { normalizeWriteToFileToolUseForDispatch } from "../presentAssistantMessage"
import type { ToolUse } from "../../../shared/tools"

describe("normalizeWriteToFileToolUseForDispatch", () => {
	it("auto-fills intent_id from active intent and defaults mutation_class", () => {
		const block: ToolUse<"write_to_file"> = {
			type: "tool_use",
			id: "tool-1",
			name: "write_to_file",
			partial: false,
			params: { path: "src/file.ts", content: "export const x = 1\n" },
			nativeArgs: {
				path: "src/file.ts",
				content: "export const x = 1\n",
				intent_id: "",
				mutation_class: undefined as unknown as "AST_REFACTOR" | "INTENT_EVOLUTION",
			},
		}

		const result = normalizeWriteToFileToolUseForDispatch({ activeIntentId: "INT-004" }, block)

		expect(result.ok).toBe(true)
		expect(block.nativeArgs?.intent_id).toBe("INT-004")
		expect(block.params.intent_id).toBe("INT-004")
		expect(block.nativeArgs?.mutation_class).toBe("AST_REFACTOR")
		expect(block.params.mutation_class).toBe("AST_REFACTOR")
	})

	it("fails when intent_id is missing and no active intent exists", () => {
		const block: ToolUse<"write_to_file"> = {
			type: "tool_use",
			id: "tool-2",
			name: "write_to_file",
			partial: false,
			params: { path: "src/file.ts", content: "export const x = 1\n" },
			nativeArgs: {
				path: "src/file.ts",
				content: "export const x = 1\n",
				intent_id: "",
				mutation_class: undefined as unknown as "AST_REFACTOR" | "INTENT_EVOLUTION",
			},
		}

		const result = normalizeWriteToFileToolUseForDispatch({ activeIntentId: undefined }, block)

		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.errorMessage).toContain("Missing value for required parameter 'intent_id'")
		}
	})

	it("does nothing for non-write tools", () => {
		const block: ToolUse<"read_file"> = {
			type: "tool_use",
			id: "tool-3",
			name: "read_file",
			partial: false,
			params: { path: "src/file.ts" },
			nativeArgs: { path: "src/file.ts" },
		}

		const result = normalizeWriteToFileToolUseForDispatch({ activeIntentId: "INT-004" }, block)

		expect(result.ok).toBe(true)
		expect((block.nativeArgs as any).intent_id).toBeUndefined()
	})
})
