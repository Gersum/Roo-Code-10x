import fs from "fs/promises"
import os from "os"
import path from "path"
import { describe, expect, it, vi } from "vitest"

import { HookEngine } from "../HookEngine"
import { Task } from "../../core/task/Task"
import type { ToolUse } from "../../shared/tools"

function createMutatingToolBlock(): ToolUse {
	return {
		type: "tool_use",
		name: "write_to_file",
		params: { path: "src/a.ts", content: "x" },
		partial: false,
		nativeArgs: { path: "src/a.ts", content: "x" },
	}
}

function createExecuteCommandBlock(command: string): ToolUse {
	return {
		type: "tool_use",
		name: "execute_command",
		params: { command },
		partial: false,
		nativeArgs: { command },
	} as ToolUse
}

function createActiveIntentsMutationBlock(toolName: ToolUse["name"] = "write_to_file"): ToolUse {
	if (toolName === "apply_diff") {
		return {
			type: "tool_use",
			name: "apply_diff",
			params: { path: ".orchestration/active_intents.yaml", diff: "@@ -1 +1 @@" },
			partial: false,
			nativeArgs: { path: ".orchestration/active_intents.yaml", diff: "@@ -1 +1 @@" },
		} as ToolUse
	}

	return {
		type: "tool_use",
		name: "write_to_file",
		params: { path: ".orchestration/active_intents.yaml", content: "active_intents: []\n" },
		partial: false,
		nativeArgs: { path: ".orchestration/active_intents.yaml", content: "active_intents: []\n" },
	}
}

describe("HookEngine two-stage + HITL gating", () => {
	it("denies mutating tools when intent checkout is not authorized for the turn", async () => {
		const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "roo-hook-stage-"))
		const orchestrationDir = path.join(workspacePath, ".orchestration")
		await fs.mkdir(orchestrationDir, { recursive: true })
		await fs.writeFile(
			path.join(orchestrationDir, "active_intents.yaml"),
			[
				"active_intents:",
				"  - id: INT-1",
				"    status: IN_PROGRESS",
				'    owned_scope: ["src/**"]',
				"    constraints: []",
				"    acceptance_criteria: []",
				"    recent_history: []",
				"    related_files: []",
				"",
			].join("\n"),
			"utf8",
		)

		const task = {
			cwd: workspacePath,
			workspacePath,
			taskId: "task-1",
			activeIntentId: "INT-1",
			didToolFailInCurrentTurn: false,
			api: { getModel: () => ({ id: "gpt-test" }) },
			getIntentCheckoutStage: () => "checkout_required",
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
		} as unknown as Task

		const engine = new HookEngine()
		const result = await engine.preToolUse(task, createMutatingToolBlock())

		expect(result.allowExecution).toBe(false)
		expect(result.errorMessage).toContain("intent checkout required")
	})

	it("allows mutating tools after checkout when HITL approves", async () => {
		const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "roo-hook-hitl-"))
		const orchestrationDir = path.join(workspacePath, ".orchestration")
		await fs.mkdir(orchestrationDir, { recursive: true })
		await fs.writeFile(
			path.join(orchestrationDir, "active_intents.yaml"),
			[
				"active_intents:",
				"  - id: INT-2",
				"    status: IN_PROGRESS",
				'    owned_scope: ["src/**"]',
				"    constraints: []",
				"    acceptance_criteria: []",
				"    recent_history: []",
				"    related_files: []",
				"",
			].join("\n"),
			"utf8",
		)

		const ask = vi.fn().mockResolvedValue({ response: "yesButtonClicked" })
		const task = {
			cwd: workspacePath,
			workspacePath,
			taskId: "task-2",
			activeIntentId: "INT-2",
			didToolFailInCurrentTurn: false,
			api: { getModel: () => ({ id: "gpt-test" }) },
			getIntentCheckoutStage: () => "execution_authorized",
			ask,
		} as unknown as Task

		const engine = new HookEngine()
		const result = await engine.preToolUse(task, createMutatingToolBlock())

		expect(result.allowExecution).toBe(true)
		expect(ask).toHaveBeenCalled()
	})

	it("returns required gatekeeper error when no valid active intent id is declared", async () => {
		const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "roo-hook-gatekeeper-"))
		const task = {
			cwd: workspacePath,
			workspacePath,
			taskId: "task-3",
			activeIntentId: undefined,
			didToolFailInCurrentTurn: false,
			api: { getModel: () => ({ id: "gpt-test" }) },
			getIntentCheckoutStage: () => "execution_authorized",
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
		} as unknown as Task

		const engine = new HookEngine()
		const result = await engine.preToolUse(task, createMutatingToolBlock())

		expect(result.allowExecution).toBe(false)
		expect(result.errorMessage).toBe("You must cite a valid active Intent ID.")
	})

	it("injects xml intent context when intercepting select_active_intent", async () => {
		const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "roo-hook-select-"))
		const orchestrationDir = path.join(workspacePath, ".orchestration")
		await fs.mkdir(orchestrationDir, { recursive: true })
		await fs.writeFile(
			path.join(orchestrationDir, "active_intents.yaml"),
			[
				"active_intents:",
				"  - id: INT-4",
				"    status: PENDING",
				'    owned_scope: ["src/auth/**", "src/middleware/jwt.ts"]',
				'    constraints: ["No external auth providers", "Keep basic auth compatibility"]',
				"    acceptance_criteria: []",
				"    recent_history: []",
				"    related_files: []",
				"",
			].join("\n"),
			"utf8",
		)

		const setPendingIntentHandshakeContext = vi.fn()
		const task = {
			cwd: workspacePath,
			workspacePath,
			taskId: "task-4",
			activeIntentId: undefined,
			didToolFailInCurrentTurn: false,
			api: { getModel: () => ({ id: "gpt-test" }) },
			setPendingIntentHandshakeContext,
			getIntentCheckoutStage: () => "checkout_required",
		} as unknown as Task

		const block: ToolUse<"select_active_intent"> = {
			type: "tool_use",
			name: "select_active_intent",
			params: { intent_id: "INT-4" },
			partial: false,
			nativeArgs: { intent_id: "INT-4" },
		}

		const engine = new HookEngine()
		const result = await engine.preToolUse(task, block)

		expect(result.allowExecution).toBe(true)
		expect(setPendingIntentHandshakeContext).toHaveBeenCalledTimes(1)
		const xml = setPendingIntentHandshakeContext.mock.calls[0][0] as string
		expect(xml).toContain("<intent_context")
		expect(xml).toContain("<owned_scope>")
		expect(xml).toContain("<constraints>")
		expect(xml).toContain("src/auth/**")
		expect(xml).toContain("No external auth providers")
	})

	it("allows bootstrap mutation of active_intents.yaml when no intents exist", async () => {
		const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "roo-hook-bootstrap-"))
		const ask = vi.fn().mockResolvedValue({ response: "yesButtonClicked" })
		const task = {
			cwd: workspacePath,
			workspacePath,
			taskId: "task-5",
			activeIntentId: undefined,
			didToolFailInCurrentTurn: false,
			api: { getModel: () => ({ id: "gpt-test" }) },
			getIntentCheckoutStage: () => "checkout_required",
			ask,
		} as unknown as Task

		const engine = new HookEngine()
		const result = await engine.preToolUse(task, createActiveIntentsMutationBlock("apply_diff"))

		expect(result.allowExecution).toBe(true)
		expect(ask).toHaveBeenCalled()
	})

	it("allows active_intents.yaml updates when an active intent is checked out", async () => {
		const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "roo-hook-control-plane-"))
		const orchestrationDir = path.join(workspacePath, ".orchestration")
		await fs.mkdir(orchestrationDir, { recursive: true })
		await fs.writeFile(
			path.join(orchestrationDir, "active_intents.yaml"),
			[
				"active_intents:",
				"  - id: INT-6",
				"    status: IN_PROGRESS",
				'    owned_scope: ["src/**"]',
				"    constraints: []",
				"    acceptance_criteria: []",
				"    recent_history: []",
				"    related_files: []",
				"",
			].join("\n"),
			"utf8",
		)

		const ask = vi.fn().mockResolvedValue({ response: "yesButtonClicked" })
		const task = {
			cwd: workspacePath,
			workspacePath,
			taskId: "task-6",
			activeIntentId: "INT-6",
			didToolFailInCurrentTurn: false,
			api: { getModel: () => ({ id: "gpt-test" }) },
			getIntentCheckoutStage: () => "execution_authorized",
			ask,
		} as unknown as Task

		const engine = new HookEngine()
		const result = await engine.preToolUse(task, createActiveIntentsMutationBlock())

		expect(result.allowExecution).toBe(true)
		expect(ask).toHaveBeenCalled()
	})

	it("classifies destructive execute_command as mutating and enforces checkout", async () => {
		const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "roo-hook-cmd-destructive-"))
		const task = {
			cwd: workspacePath,
			workspacePath,
			taskId: "task-7",
			activeIntentId: undefined,
			didToolFailInCurrentTurn: false,
			api: { getModel: () => ({ id: "gpt-test" }) },
			getIntentCheckoutStage: () => "checkout_required",
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
		} as unknown as Task

		const engine = new HookEngine()
		const result = await engine.preToolUse(task, createExecuteCommandBlock("rm -rf ./tmp"))

		expect(result.allowExecution).toBe(false)
		expect(result.errorMessage).toContain("intent checkout required")
	})

	it("allows safe execute_command without intent checkout", async () => {
		const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "roo-hook-cmd-safe-"))
		const task = {
			cwd: workspacePath,
			workspacePath,
			taskId: "task-8",
			activeIntentId: undefined,
			didToolFailInCurrentTurn: false,
			api: { getModel: () => ({ id: "gpt-test" }) },
			getIntentCheckoutStage: () => "checkout_required",
		} as unknown as Task

		const engine = new HookEngine()
		const result = await engine.preToolUse(task, createExecuteCommandBlock("rg -n todo src"))

		expect(result.allowExecution).toBe(true)
	})

	it("blocks ignored intents from mutating when matched by .intentignore", async () => {
		const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "roo-hook-intent-ignore-"))
		await fs.writeFile(path.join(workspacePath, ".intentignore"), "INT-9\n", "utf8")
		const orchestrationDir = path.join(workspacePath, ".orchestration")
		await fs.mkdir(orchestrationDir, { recursive: true })
		await fs.writeFile(
			path.join(orchestrationDir, "active_intents.yaml"),
			[
				"active_intents:",
				"  - id: INT-9",
				"    status: IN_PROGRESS",
				'    owned_scope: ["src/**"]',
				"    constraints: []",
				"    acceptance_criteria: []",
				"    recent_history: []",
				"    related_files: []",
				"",
			].join("\n"),
			"utf8",
		)

		const task = {
			cwd: workspacePath,
			workspacePath,
			taskId: "task-9",
			activeIntentId: "INT-9",
			didToolFailInCurrentTurn: false,
			api: { getModel: () => ({ id: "gpt-test" }) },
			getIntentCheckoutStage: () => "execution_authorized",
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
		} as unknown as Task

		const engine = new HookEngine()
		const result = await engine.preToolUse(task, createMutatingToolBlock())

		expect(result.allowExecution).toBe(false)
		expect(result.errorMessage).toContain('"code":"INTENT_IGNORED"')
	})
})
