import crypto from "crypto"
import fs from "fs/promises"
import path from "path"
import { execFile } from "child_process"
import { promisify } from "util"
import * as vscode from "vscode"

import type { ToolName } from "@roo-code/types"

import type { ToolUse } from "../shared/tools"
import { Task } from "../core/task/Task"
import { type ActiveIntentRecord, type AgentTraceRecord, OrchestrationStore } from "./OrchestrationStore"
import { IntentContextService } from "./IntentContextService"
import { parseSourceCodeDefinitionsForFile } from "../services/tree-sitter"
import { sha256OfBuffer, sha256OfString } from "../utils/hash"

const execFileAsync = promisify(execFile)

const MUTATING_TOOLS = new Set<ToolName>([
	"write_to_file",
	"apply_diff",
	"edit",
	"search_and_replace",
	"search_replace",
	"edit_file",
	"apply_patch",
	"generate_image",
])

const APPLY_PATCH_FILE_MARKERS = ["*** Add File: ", "*** Delete File: ", "*** Update File: ", "*** Move to: "] as const
const INTENT_IGNORE_FEEDBACK_LIMIT = 3

type CommandClassification = "safe" | "destructive"
type MutationClass = "AST_REFACTOR" | "INTENT_EVOLUTION"

interface ExtractedPaths {
	insideWorkspacePaths: string[]
	outsideWorkspacePaths: string[]
}

interface StaleFileViolation {
	relativePath: string
	expectedHash: string
	currentHash: string
}

export interface HookPreToolUseContext {
	toolName: string
	isMutatingTool: boolean
	commandClassification: CommandClassification
	intentId?: string
	intent?: ActiveIntentRecord
	touchedPaths: string[]
	sidecarConstraints: string[]
	sidecarVersion: number
	hadToolFailureBefore: boolean
}

export interface HookPreToolUseResult {
	allowExecution: boolean
	errorMessage?: string
	context: HookPreToolUseContext
}

function normalizePathLike(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined
	}

	const normalized = value.trim()
	return normalized.length > 0 ? normalized : undefined
}

function globToRegExp(globPattern: string): RegExp {
	const normalized = globPattern.trim().replace(/\\/g, "/").replace(/^\.\//, "")
	const escaped = normalized
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "__DOUBLE_STAR__")
		.replace(/\*/g, "[^/]*")
		.replace(/__DOUBLE_STAR__/g, ".*")

	return new RegExp(`^${escaped}$`)
}

function toUnique(values: string[]): string[] {
	return Array.from(new Set(values))
}

function isNumberedSpecIterationPath(relativePath: string): boolean {
	const normalizedPath = relativePath.replace(/\\/g, "/").replace(/^\.\//, "")
	return /^specs\/\d{3}-[^/]+(?:\/|$)/.test(normalizedPath)
}

export class HookEngine {
	private buildIntentContextXml(intent: ActiveIntentRecord): string {
		const scopeXml =
			intent.owned_scope.length > 0
				? intent.owned_scope.map((pathGlob) => `    <path>${pathGlob}</path>`).join("\n")
				: "    <path>(none)</path>"
		const constraintsXml =
			intent.constraints.length > 0
				? intent.constraints.map((constraint) => `    <constraint>${constraint}</constraint>`).join("\n")
				: "    <constraint>(none)</constraint>"

		return [
			`<intent_context id="${intent.id}">`,
			"  <owned_scope>",
			scopeXml,
			"  </owned_scope>",
			"  <constraints>",
			constraintsXml,
			"  </constraints>",
			"</intent_context>",
		].join("\n")
	}

	private classifyExecuteCommand(block: ToolUse): CommandClassification {
		if (block.name !== "execute_command") {
			return "safe"
		}
		const nativeArgs = (block.nativeArgs as Record<string, unknown> | undefined) ?? {}
		const command = normalizePathLike(nativeArgs.command ?? block.params.command)?.toLowerCase()
		if (!command) {
			return "destructive"
		}

		const destructivePatterns = [
			/\brm\b/,
			/\bmv\b/,
			/\bcp\b/,
			/\bchmod\b/,
			/\bchown\b/,
			/\bmkdir\b/,
			/\brmdir\b/,
			/\bsed\s+-i\b/,
			/\btee\b/,
			/\bgit\s+(add|commit|merge|rebase|reset|clean|checkout)\b/,
			/\bnpm\s+(publish|version)\b/,
			/\bpnpm\s+(publish|version)\b/,
			/\byarn\s+(publish|version)\b/,
			/\bpython\b.*\b(open|write|remove|unlink)\b/,
			/\bnode\b/,
			/>/,
		]
		const safeAllowPatterns = [
			/^\s*(ls|cat|pwd|echo|whoami|date|rg|find|git\s+status|git\s+log|git\s+show|git\s+rev-parse)\b/,
		]
		if (safeAllowPatterns.some((pattern) => pattern.test(command))) {
			return "safe"
		}
		return destructivePatterns.some((pattern) => pattern.test(command)) ? "destructive" : "safe"
	}

	private buildHookToolError(code: string, message: string, details?: Record<string, unknown>): string {
		return JSON.stringify(
			{
				error: {
					type: "HOOK_PRE_TOOL_DENIED",
					code,
					message,
					...(details ? { details } : {}),
				},
			},
			null,
			0,
		)
	}

	private intentMatchesIgnorePattern(intentId: string, pattern: string): boolean {
		if (!pattern.trim()) {
			return false
		}
		const regex = globToRegExp(pattern.trim())
		return regex.test(intentId)
	}

	private async requestHitlAuthorization(
		task: Task,
		toolName: string,
		intentId: string,
		paths: string[],
	): Promise<{ approved: boolean; feedback?: string }> {
		const warningMessage = `Approve ${toolName} for intent ${intentId}?`
		const detail = paths.length > 0 ? `Paths: ${paths.join(", ")}` : "No explicit path targets detected."
		try {
			const decision = await vscode.window.showWarningMessage(
				warningMessage,
				{ modal: true, detail },
				"Approve",
				"Reject",
			)
			if (decision === "Reject") {
				return { approved: false, feedback: "Rejected from VS Code warning gate." }
			}
			if (decision === "Approve") {
				return { approved: true }
			}
		} catch {
			// Fall through to task.ask gate below.
		}

		if (typeof (task as Task & { ask?: unknown }).ask === "function") {
			const hitlPayload = JSON.stringify({
				tool: "preToolAuthorization",
				requested_tool: toolName,
				intent_id: intentId,
				paths,
			})
			const { response, text } = await task.ask("tool", hitlPayload)
			if (response === "yesButtonClicked") {
				return { approved: true }
			}
			return { approved: false, feedback: typeof text === "string" ? text : undefined }
		}

		return { approved: true }
	}

	async preToolUse(task: Task, block: ToolUse): Promise<HookPreToolUseResult> {
		const toolName = String(block.name)
		const commandClassification = this.classifyExecuteCommand(block)
		const isMutatingTool =
			MUTATING_TOOLS.has(block.name as ToolName) ||
			(block.name === "execute_command" && commandClassification === "destructive")
		const workspacePath = this.getWorkspacePath(task)
		if (!workspacePath) {
			return {
				allowExecution: true,
				context: {
					toolName,
					isMutatingTool,
					commandClassification,
					touchedPaths: [],
					sidecarConstraints: [],
					sidecarVersion: 1,
					hadToolFailureBefore: task.didToolFailInCurrentTurn,
				},
			}
		}

		const store = new OrchestrationStore(workspacePath)
		await store.ensureInitialized()
		const contract = await store.getDirectoryContractStatus()

		const extractedPaths = this.extractTouchedPaths(workspacePath, block)
		const sidecar = await store.loadSidecarPolicy()
		const context: HookPreToolUseContext = {
			toolName,
			isMutatingTool,
			commandClassification,
			touchedPaths: extractedPaths.insideWorkspacePaths,
			sidecarConstraints: sidecar.architectural_constraints,
			sidecarVersion: sidecar.version,
			hadToolFailureBefore: task.didToolFailInCurrentTurn,
		}

		if (toolName === "select_active_intent") {
			const requestedIntentId = this.extractRequestedIntentId(block)
			if (requestedIntentId) {
				const intentContextService = new IntentContextService(store)
				const selectedIntent = await intentContextService.selectIntent(requestedIntentId)
				if (selectedIntent.found && selectedIntent.context) {
					const handshakeContext = this.buildIntentContextXml({
						id: selectedIntent.context.id,
						name: selectedIntent.context.name,
						status: selectedIntent.context.status,
						owned_scope: selectedIntent.context.owned_scope,
						constraints: selectedIntent.context.constraints,
						acceptance_criteria: selectedIntent.context.acceptance_criteria,
						recent_history: selectedIntent.context.recent_history,
						related_files: selectedIntent.context.related_files,
					})
					task.setPendingIntentHandshakeContext(handshakeContext)
				}
				await intentContextService.markIntentInProgress(requestedIntentId)
			}

			return { allowExecution: true, context }
		}

		if (!isMutatingTool) {
			return { allowExecution: true, context }
		}

		const activeIntentsRelativePath = path.posix.join(
			OrchestrationStore.ORCHESTRATION_DIR,
			OrchestrationStore.ACTIVE_INTENTS_FILE,
		)
		const touchesOnlyActiveIntentsFile =
			extractedPaths.insideWorkspacePaths.length > 0 &&
			extractedPaths.outsideWorkspacePaths.length === 0 &&
			extractedPaths.insideWorkspacePaths.every((relativePath) => relativePath === activeIntentsRelativePath)
		let isActiveIntentBootstrapMutation = false
		if (touchesOnlyActiveIntentsFile) {
			const intents = await store.loadIntents()
			isActiveIntentBootstrapMutation = intents.length === 0
		}

		// Two-stage turn state machine:
		// stage 1: checkout_required (must call select_active_intent first)
		// stage 2: execution_authorized (mutating tools allowed)
		//
		// Enforce strictly for real Task instances; test doubles that don't use
		// Task can bypass to keep existing unit tests isolated from runtime policy.
		const stage =
			typeof (task as Task & { getIntentCheckoutStage?: () => string }).getIntentCheckoutStage === "function"
				? (task as Task & { getIntentCheckoutStage: () => string }).getIntentCheckoutStage()
				: "execution_authorized"
		if (stage !== "execution_authorized" && !isActiveIntentBootstrapMutation) {
			await store.appendGovernanceEntry({
				intent_id: task.activeIntentId,
				tool_name: toolName,
				status: "DENIED",
				task_id: task.taskId,
				model_identifier: task.api.getModel().id,
				revision_id: await this.getGitRevision(task.cwd),
				touched_paths: context.touchedPaths,
				sidecar_constraints: context.sidecarConstraints,
			})
			return {
				allowExecution: false,
				context,
				errorMessage:
					`PreToolUse denied ${toolName}: intent checkout required for this turn. ` +
					`Call select_active_intent before mutating tools.`,
			}
		}

		if (!contract.isCompliant) {
			const missing = contract.missingRequiredFiles
			const unexpected = contract.unexpectedEntries
			const contractErrorParts: string[] = []
			if (missing.length > 0) {
				contractErrorParts.push(`missing required files: ${missing.join(", ")}`)
			}
			if (unexpected.length > 0) {
				contractErrorParts.push(`unexpected entries: ${unexpected.join(", ")}`)
			}
			const contractError = contractErrorParts.join("; ")

			await store.appendSharedBrainEntry(
				`Orchestration contract drift detected. Denied ${toolName}. Details: ${contractError}`,
			)
			await store.appendGovernanceEntry({
				intent_id: task.activeIntentId,
				tool_name: toolName,
				status: "DENIED",
				task_id: task.taskId,
				model_identifier: task.api.getModel().id,
				revision_id: await this.getGitRevision(task.cwd),
				touched_paths: context.touchedPaths,
				sidecar_constraints: context.sidecarConstraints,
			})
			return {
				allowExecution: false,
				context,
				errorMessage:
					`PreToolUse denied ${toolName}: .orchestration directory contract violation (${contractError}). ` +
					`Restore required control-plane files and remove unexpected entries.`,
			}
		}

		if (sidecar.blocked_tools.includes(toolName)) {
			await store.appendGovernanceEntry({
				intent_id: task.activeIntentId,
				tool_name: toolName,
				status: "DENIED",
				task_id: task.taskId,
				model_identifier: task.api.getModel().id,
				revision_id: await this.getGitRevision(task.cwd),
				touched_paths: context.touchedPaths,
				sidecar_constraints: context.sidecarConstraints,
			})
			return {
				allowExecution: false,
				context,
				errorMessage: `PreToolUse denied ${toolName}: blocked by sidecar policy v${sidecar.version}.`,
			}
		}

		if (extractedPaths.insideWorkspacePaths.length > 0) {
			const deniedBySidecar = extractedPaths.insideWorkspacePaths.filter((relativePath) =>
				sidecar.deny_mutations.some((rule) => this.pathMatchesOwnedScope(relativePath, [rule.path_glob])),
			)
			const deniedBySidecarAfterControlPlaneException = deniedBySidecar.filter(
				(relativePath) => relativePath !== activeIntentsRelativePath,
			)
			if (deniedBySidecarAfterControlPlaneException.length > 0) {
				await store.appendGovernanceEntry({
					intent_id: task.activeIntentId,
					tool_name: toolName,
					status: "DENIED",
					task_id: task.taskId,
					model_identifier: task.api.getModel().id,
					revision_id: await this.getGitRevision(task.cwd),
					touched_paths: context.touchedPaths,
					sidecar_constraints: context.sidecarConstraints,
				})
				return {
					allowExecution: false,
					context,
					errorMessage:
						`PreToolUse denied ${toolName}: sidecar policy v${sidecar.version} denies mutation for path(s): ` +
						`${deniedBySidecarAfterControlPlaneException.join(", ")}.`,
				}
			}
		}

		if (extractedPaths.outsideWorkspacePaths.length > 0) {
			await store.appendGovernanceEntry({
				intent_id: task.activeIntentId,
				tool_name: toolName,
				status: "DENIED",
				task_id: task.taskId,
				model_identifier: task.api.getModel().id,
				revision_id: await this.getGitRevision(task.cwd),
				touched_paths: context.touchedPaths,
				sidecar_constraints: context.sidecarConstraints,
			})
			return {
				allowExecution: false,
				context,
				errorMessage:
					`PreToolUse denied ${toolName}: attempted to mutate paths outside the workspace boundary. ` +
					`Paths: ${extractedPaths.outsideWorkspacePaths.join(", ")}`,
			}
		}

		if (isActiveIntentBootstrapMutation) {
			// Bootstrap path: permit the first active_intents.yaml mutation so teams can initialize
			// intent governance from an empty state without disabling hooks.
			const hitl = await this.requestHitlAuthorization(task, toolName, "INTENT-BOOTSTRAP", context.touchedPaths)
			if (!hitl.approved) {
				await store.appendGovernanceEntry({
					tool_name: toolName,
					status: "DENIED",
					task_id: task.taskId,
					model_identifier: task.api.getModel().id,
					revision_id: await this.getGitRevision(task.cwd),
					touched_paths: context.touchedPaths,
					sidecar_constraints: context.sidecarConstraints,
				})
				return {
					allowExecution: false,
					context,
					errorMessage: this.buildHookToolError("HITL_REJECTED", "Mutation rejected by authorization gate.", {
						tool_name: toolName,
						intent_id: "INTENT-BOOTSTRAP",
						feedback: hitl.feedback,
					}),
				}
			}

			await store.appendSharedBrainEntry(
				"Bootstrap mutation approved for .orchestration/active_intents.yaml with no existing intents.",
			)
			return { allowExecution: true, context }
		}

		const activeIntentId = task.activeIntentId?.trim()
		if (!activeIntentId) {
			await store.appendGovernanceEntry({
				tool_name: toolName,
				status: "DENIED",
				task_id: task.taskId,
				model_identifier: task.api.getModel().id,
				revision_id: await this.getGitRevision(task.cwd),
				touched_paths: context.touchedPaths,
				sidecar_constraints: context.sidecarConstraints,
			})
			return {
				allowExecution: false,
				context,
				errorMessage: "You must cite a valid active Intent ID.",
			}
		}

		const intent = await store.findIntentById(activeIntentId)
		if (!intent) {
			await store.appendGovernanceEntry({
				intent_id: activeIntentId,
				tool_name: toolName,
				status: "DENIED",
				task_id: task.taskId,
				model_identifier: task.api.getModel().id,
				revision_id: await this.getGitRevision(task.cwd),
				touched_paths: context.touchedPaths,
				sidecar_constraints: context.sidecarConstraints,
			})
			return {
				allowExecution: false,
				context,
				errorMessage: "You must cite a valid active Intent ID.",
			}
		}

		context.intentId = intent.id
		context.intent = intent

		const ignoredIntentPatterns = await store.loadIntentIgnorePatterns()
		const matchedIgnoredPatterns = ignoredIntentPatterns.filter((pattern) =>
			this.intentMatchesIgnorePattern(intent.id, pattern),
		)
		if (matchedIgnoredPatterns.length > 0) {
			await store.appendGovernanceEntry({
				intent_id: intent.id,
				tool_name: toolName,
				status: "DENIED",
				task_id: task.taskId,
				model_identifier: task.api.getModel().id,
				revision_id: await this.getGitRevision(task.cwd),
				touched_paths: context.touchedPaths,
				sidecar_constraints: context.sidecarConstraints,
			})
			return {
				allowExecution: false,
				context,
				errorMessage: this.buildHookToolError(
					"INTENT_IGNORED",
					`Intent ${intent.id} is excluded by .intentignore and cannot mutate code in this session.`,
					{
						intent_id: intent.id,
						matched_patterns: matchedIgnoredPatterns.slice(0, INTENT_IGNORE_FEEDBACK_LIMIT),
					},
				),
			}
		}

		const scopeCheckedPaths = extractedPaths.insideWorkspacePaths.filter(
			(relativePath) => relativePath !== activeIntentsRelativePath,
		)
		if (intent.owned_scope.length > 0 && scopeCheckedPaths.length > 0) {
			const disallowedPaths = scopeCheckedPaths.filter(
				(filePath) => !this.pathMatchesOwnedScope(filePath, intent.owned_scope),
			)

			if (disallowedPaths.length > 0) {
				await store.appendSharedBrainEntry(
					`Scope violation blocked for intent ${intent.id}. Disallowed paths: ${disallowedPaths.join(", ")}`,
				)
				await store.appendGovernanceEntry({
					intent_id: intent.id,
					tool_name: toolName,
					status: "DENIED",
					task_id: task.taskId,
					model_identifier: task.api.getModel().id,
					revision_id: await this.getGitRevision(task.cwd),
					touched_paths: context.touchedPaths,
					sidecar_constraints: context.sidecarConstraints,
				})
				return {
					allowExecution: false,
					context,
					errorMessage:
						toolName === "write_to_file"
							? `Scope Violation: ${this.resolveSpecificationReference(intent.id, intent)} is not authorized to edit ${disallowedPaths[0]}. Request scope expansion.`
							: `PreToolUse denied ${toolName}: path(s) outside owned_scope for intent ${intent.id}. Disallowed: ${disallowedPaths.join(", ")}`,
				}
			}
		}

		const staleFileViolations = await this.detectStaleFileViolations(task, workspacePath, scopeCheckedPaths)
		if (staleFileViolations.length > 0) {
			const firstViolation = staleFileViolations[0]
			await store.appendGovernanceEntry({
				intent_id: intent.id,
				tool_name: toolName,
				status: "DENIED",
				task_id: task.taskId,
				model_identifier: task.api.getModel().id,
				revision_id: await this.getGitRevision(task.cwd),
				touched_paths: context.touchedPaths,
				sidecar_constraints: context.sidecarConstraints,
			})
			return {
				allowExecution: false,
				context,
				errorMessage: this.buildHookToolError(
					"STALE_FILE",
					`Stale File: ${firstViolation.relativePath} changed since it was read. Re-read before writing.`,
					{
						path: firstViolation.relativePath,
						expected_hash: firstViolation.expectedHash,
						current_hash: firstViolation.currentHash,
					},
				),
			}
		}

		if (toolName === "write_to_file") {
			const mutationClass = this.extractMutationClass(block)
			const numberedSpecPaths = scopeCheckedPaths.filter(isNumberedSpecIterationPath)
			if (numberedSpecPaths.length > 0 && mutationClass !== "INTENT_EVOLUTION") {
				const createdSpecPaths: string[] = []
				for (const relativePath of numberedSpecPaths) {
					const absolutePath = path.join(workspacePath, relativePath)
					try {
						await fs.access(absolutePath)
					} catch (error) {
						const fsError = error as NodeJS.ErrnoException
						if (fsError.code === "ENOENT") {
							createdSpecPaths.push(relativePath)
						} else {
							throw error
						}
					}
				}

				if (createdSpecPaths.length > 0) {
					await store.appendGovernanceEntry({
						intent_id: intent.id,
						tool_name: toolName,
						status: "DENIED",
						task_id: task.taskId,
						model_identifier: task.api.getModel().id,
						revision_id: await this.getGitRevision(task.cwd),
						touched_paths: context.touchedPaths,
						sidecar_constraints: context.sidecarConstraints,
					})
					return {
						allowExecution: false,
						context,
						errorMessage: this.buildHookToolError(
							"SPEC_ITERATION_REQUIRES_INTENT_EVOLUTION",
							"Creating new specs/NNN-* files requires mutation_class INTENT_EVOLUTION.",
							{
								intent_id: intent.id,
								paths: createdSpecPaths,
								mutation_class: mutationClass ?? "MISSING",
							},
						),
					}
				}
			}
		}

		// Explicit context injection marker for traceability in intent history.
		await store.appendRecentHistory(intent.id, `INTENT_CONTEXT_INJECTED ${toolName}`)

		// Human-in-the-loop authorization gate in pre-hook for mutating tools.
		// For production Task instances, we require explicit approval before tool execution.
		const hitl = await this.requestHitlAuthorization(task, toolName, intent.id, context.touchedPaths)
		if (!hitl.approved) {
			await store.appendGovernanceEntry({
				intent_id: intent.id,
				tool_name: toolName,
				status: "DENIED",
				task_id: task.taskId,
				model_identifier: task.api.getModel().id,
				revision_id: await this.getGitRevision(task.cwd),
				touched_paths: context.touchedPaths,
				sidecar_constraints: context.sidecarConstraints,
			})
			return {
				allowExecution: false,
				context,
				errorMessage: this.buildHookToolError("HITL_REJECTED", "Mutation rejected by authorization gate.", {
					tool_name: toolName,
					intent_id: intent.id,
					feedback: hitl.feedback,
				}),
			}
		}

		await store.appendRecentHistory(intent.id, `PRE_HOOK ${toolName}`)
		return { allowExecution: true, context }
	}

	async postToolUse(
		task: Task,
		block: ToolUse,
		context: HookPreToolUseContext,
		executionSucceeded: boolean,
	): Promise<void> {
		const workspacePath = this.getWorkspacePath(task)
		if (!workspacePath) {
			return
		}

		const store = new OrchestrationStore(workspacePath)
		await store.ensureInitialized()

		if (context.intentId) {
			const statusLabel = executionSucceeded ? "OK" : "FAILED"
			await store.appendRecentHistory(context.intentId, `POST_HOOK ${context.toolName} ${statusLabel}`)
		}
		await store.appendGovernanceEntry({
			intent_id: context.intentId,
			tool_name: context.toolName,
			status: executionSucceeded ? "OK" : "FAILED",
			task_id: task.taskId,
			model_identifier: task.api.getModel().id,
			revision_id: await this.getGitRevision(task.cwd),
			touched_paths: context.touchedPaths,
			sidecar_constraints: context.sidecarConstraints,
		})

		if (context.toolName === "attempt_completion" && executionSucceeded && task.activeIntentId) {
			const intentContextService = new IntentContextService(store)
			await intentContextService.markIntentCompleted(task.activeIntentId)
			await store.appendSharedBrainEntry(`Intent ${task.activeIntentId} marked COMPLETED by attempt_completion.`)
			return
		}

		if (!context.isMutatingTool || !context.intentId) {
			return
		}

		if (!executionSucceeded) {
			await store.appendSharedBrainEntry(
				`Mutating tool ${context.toolName} failed for intent ${context.intentId}. Verification or retry needed.`,
			)
			return
		}

		const traceRecord = await this.buildTraceRecord(task, context, block)
		if (traceRecord.files.length === 0) {
			return
		}

		await store.appendTraceRecord(traceRecord)
		if (context.intent) {
			const astFingerprints = Object.fromEntries(
				traceRecord.files.map((file) => [file.relative_path, file.ast_fingerprint?.summary_hash]),
			)
			await store.appendIntentMapEntry(context.intent, context.touchedPaths, astFingerprints)
		}
	}

	private getWorkspacePath(task: Task): string | undefined {
		const fromWorkspacePath = (task as Task & { workspacePath?: string }).workspacePath
		if (typeof fromWorkspacePath === "string" && fromWorkspacePath.trim().length > 0) {
			return fromWorkspacePath.trim()
		}

		const cwd = task.cwd
		if (typeof cwd === "string" && cwd.trim().length > 0) {
			return cwd.trim()
		}

		return undefined
	}

	private extractRequestedIntentId(block: ToolUse): string | undefined {
		const nativeArgs = block.nativeArgs as Record<string, unknown> | undefined
		const fromNative = normalizePathLike(nativeArgs?.intent_id)
		if (fromNative) {
			return fromNative
		}

		return normalizePathLike(block.params.intent_id)
	}

	private extractTouchedPaths(cwd: string, block: ToolUse): ExtractedPaths {
		const nativeArgs = (block.nativeArgs as Record<string, unknown> | undefined) ?? {}
		const fallbackParams = block.params
		const pathCandidates: string[] = []

		const add = (value: unknown) => {
			const normalized = normalizePathLike(value)
			if (normalized) {
				pathCandidates.push(normalized)
			}
		}

		switch (block.name) {
			case "write_to_file":
			case "apply_diff":
				add(nativeArgs.path ?? fallbackParams.path)
				break

			case "edit":
			case "search_and_replace":
			case "search_replace":
			case "edit_file":
				add(nativeArgs.file_path ?? fallbackParams.file_path ?? fallbackParams.path)
				break

			case "generate_image":
				add(nativeArgs.path ?? fallbackParams.path)
				break

			case "apply_patch": {
				const patch = normalizePathLike(nativeArgs.patch ?? fallbackParams.patch)
				if (patch) {
					for (const line of patch.split(/\r?\n/)) {
						for (const marker of APPLY_PATCH_FILE_MARKERS) {
							if (line.startsWith(marker)) {
								add(line.slice(marker.length))
								break
							}
						}
					}
				}
				break
			}

			default:
				break
		}

		const insideWorkspacePaths: string[] = []
		const outsideWorkspacePaths: string[] = []

		for (const candidate of toUnique(pathCandidates)) {
			const normalized = this.normalizeWorkspaceRelativePath(cwd, candidate)
			if (normalized) {
				insideWorkspacePaths.push(normalized)
			} else {
				outsideWorkspacePaths.push(candidate)
			}
		}

		return {
			insideWorkspacePaths,
			outsideWorkspacePaths,
		}
	}

	private normalizeWorkspaceRelativePath(cwd: string, candidatePath: string): string | null {
		const resolved = path.isAbsolute(candidatePath) ? path.resolve(candidatePath) : path.resolve(cwd, candidatePath)
		const relative = path.relative(cwd, resolved)
		if (relative.startsWith("..") || path.isAbsolute(relative)) {
			return null
		}

		return relative.replace(/\\/g, "/")
	}

	private pathMatchesOwnedScope(relativePath: string, ownedScope: string[]): boolean {
		const normalizedPath = relativePath.replace(/\\/g, "/").replace(/^\.\//, "")
		return ownedScope.some((pattern) => {
			const normalizedPattern = pattern.replace(/\\/g, "/").replace(/^\.\//, "")
			const regex = globToRegExp(normalizedPattern)
			return regex.test(normalizedPath)
		})
	}

	private async detectStaleFileViolations(
		task: Task,
		workspacePath: string,
		relativePaths: string[],
	): Promise<StaleFileViolation[]> {
		if (relativePaths.length === 0) {
			return []
		}

		const taskWithReadHashes = task as Task & {
			getReadHashForCurrentTurn?: (relativePath: string) => string | undefined
		}
		if (typeof taskWithReadHashes.getReadHashForCurrentTurn !== "function") {
			return []
		}

		const violations: StaleFileViolation[] = []
		for (const relativePath of toUnique(relativePaths)) {
			const expectedHash = taskWithReadHashes.getReadHashForCurrentTurn(relativePath)
			if (!expectedHash) {
				continue
			}

			const absolutePath = path.join(workspacePath, relativePath)
			let currentHash = "MISSING"
			try {
				const currentBuffer = await fs.readFile(absolutePath)
				currentHash = sha256OfBuffer(currentBuffer)
			} catch (error) {
				const fsError = error as NodeJS.ErrnoException
				if (fsError.code !== "ENOENT") {
					throw error
				}
			}

			if (currentHash !== expectedHash) {
				violations.push({
					relativePath,
					expectedHash,
					currentHash,
				})
			}
		}

		return violations
	}

	private extractToolPayloadForPath(block: ToolUse, relativePath: string): string | undefined {
		const nativeArgs = (block.nativeArgs as Record<string, unknown> | undefined) ?? {}
		const params = block.params
		const normalizedRelativePath = relativePath.replace(/\\/g, "/")

		const normalizeCandidatePath = (value: unknown): string | undefined => {
			const normalized = normalizePathLike(value)
			return normalized ? normalized.replace(/\\/g, "/").replace(/^\.\//, "") : undefined
		}

		const toolPath =
			normalizeCandidatePath(nativeArgs.path) ??
			normalizeCandidatePath(nativeArgs.file_path) ??
			normalizeCandidatePath(params.path) ??
			normalizeCandidatePath(params.file_path)

		const pathMatches = !toolPath || toolPath === normalizedRelativePath
		if (!pathMatches) {
			return undefined
		}

		switch (block.name) {
			case "write_to_file":
				return normalizePathLike(nativeArgs.content ?? params.content)
			case "apply_diff":
				return normalizePathLike(nativeArgs.diff ?? params.diff)
			case "edit":
			case "search_and_replace":
			case "search_replace":
			case "edit_file":
				return normalizePathLike(nativeArgs.new_string ?? params.new_string)
			case "apply_patch":
				return normalizePathLike(nativeArgs.patch ?? params.patch)
			default:
				return undefined
		}
	}

	private extractMutationClass(block?: ToolUse): MutationClass | undefined {
		if (!block || block.name !== "write_to_file") {
			return undefined
		}
		const nativeArgs = (block.nativeArgs as Record<string, unknown> | undefined) ?? {}
		const raw = normalizePathLike(nativeArgs.mutation_class ?? block.params.mutation_class)
		if (raw === "AST_REFACTOR" || raw === "INTENT_EVOLUTION") {
			return raw
		}
		return undefined
	}

	private resolveSpecificationReference(intentId: string, intent?: ActiveIntentRecord): string {
		const candidateKeys = ["specification_id", "requirement_id", "req_id", "spec_id"] as const
		for (const key of candidateKeys) {
			const value = intent?.[key]
			if (typeof value === "string" && value.trim().length > 0) {
				return value.trim()
			}
		}
		return intentId
	}

	private async buildTraceRecord(
		task: Task,
		context: HookPreToolUseContext,
		block?: ToolUse,
	): Promise<AgentTraceRecord> {
		const files = []
		for (const relativePath of toUnique(context.touchedPaths)) {
			const absolutePath = path.join(task.cwd, relativePath)

			let fileBuffer: Buffer
			try {
				fileBuffer = await fs.readFile(absolutePath)
			} catch {
				// Deleted/non-text files still emit a stable empty hash range.
				fileBuffer = Buffer.alloc(0)
			}

			const contentHash = sha256OfBuffer(fileBuffer)
			const text = fileBuffer.toString("utf8")
			const lineCount = text.length === 0 ? 0 : text.split(/\r?\n/).length
			const payloadText = block ? this.extractToolPayloadForPath(block, relativePath) : undefined
			const payloadLineCount = payloadText ? payloadText.split(/\r?\n/).length : 0
			const rangeStart = payloadText ? 1 : lineCount > 0 ? 1 : 0
			const rangeEnd = payloadText ? payloadLineCount : lineCount
			const rangeHash = payloadText ? sha256OfString(payloadText) : contentHash
			let astSummaryHash: string | undefined
			try {
				const astSummary = await parseSourceCodeDefinitionsForFile(absolutePath)
				if (astSummary && astSummary.trim().length > 0) {
					astSummaryHash = sha256OfString(astSummary)
				}
			} catch {
				// Best-effort AST extraction for trace linkage.
			}

			const specificationRef = this.resolveSpecificationReference(context.intentId!, context.intent)
			const mutationClass = this.extractMutationClass(block)
			files.push({
				relative_path: relativePath,
				...(astSummaryHash
					? {
							ast_fingerprint: {
								parser: "tree-sitter" as const,
								summary_hash: astSummaryHash,
							},
						}
					: {}),
				conversations: [
					{
						url: task.taskId,
						contributor: {
							entity_type: "AI" as const,
							model_identifier: task.api.getModel().id,
						},
						ranges: [
							{
								start_line: rangeStart,
								end_line: rangeEnd,
								content_hash: rangeHash,
							},
						],
						related: [
							{ type: "specification" as const, value: specificationRef },
							...(mutationClass ? [{ type: "mutation_class" as const, value: mutationClass }] : []),
						],
					},
				],
			})
		}

		return {
			id: crypto.randomUUID(),
			timestamp: new Date().toISOString(),
			vcs: {
				revision_id: await this.getGitRevision(task.cwd),
			},
			files,
		}
	}

	private async getGitRevision(cwd: string): Promise<string> {
		try {
			const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })
			const revision = stdout.trim()
			return revision.length > 0 ? revision : "UNKNOWN"
		} catch {
			return "UNKNOWN"
		}
	}
}

export const hookEngine = new HookEngine()

// hook-smoke
