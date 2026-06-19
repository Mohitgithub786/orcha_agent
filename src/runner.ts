import { StateGraph, MessagesAnnotation, START, END } from '@langchain/langgraph'
import { AIMessage } from '@langchain/core/messages'
import { logger } from './utils/logger'
import { MemorySaver } from '@langchain/langgraph'
import { z } from 'zod'
import { getToolsForAgent } from './registry/registry'
import { executeTool } from './executors'
import { runLogQueries } from './db/queries'
import { agentQueries } from './db/queries'
import type { Tool } from './db/schema'
import { getMissingCredentials } from './vault'
import { trace } from '@opentelemetry/api'

// Vercel AI SDK imports
import { tool, generateText, stepCountIs, type ModelMessage } from 'ai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createGroq } from '@ai-sdk/groq'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'

// Use MemorySaver instead of PostgresSaver to avoid corrupted checkpoint state
// Each server restart gives a clean slate — no stale tool-call history
export const checkpointer = new MemorySaver()

// Build the correct Vercel AI SDK provider model
function buildVercelLLM(modelName: string) {
    const name = modelName?.toLowerCase() || 'llama-3.3-70b-versatile'
    if (name.startsWith('gemini') || name.includes('google')) {
        const googleInstance = createGoogleGenerativeAI({
            apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY
        })
        return googleInstance(modelName || 'gemini-3-flash-preview')
    }
    if (name.startsWith('llama') || name.startsWith('mixtral') || name.startsWith('deepseek') || name.includes('groq')) {
        const groqInstance = createGroq({
            apiKey: process.env.GROQ_API_KEY
        })
        return groqInstance(modelName || 'llama-3.3-70b-versatile')
    }
    if (name.startsWith('claude') || name.includes('anthropic')) {
        const anthropicInstance = createAnthropic({
            apiKey: process.env.ANTHROPIC_API_KEY
        })
        return anthropicInstance(modelName || 'claude-3-5-sonnet-latest')
    }
    if (name.startsWith('gpt') || name.includes('openai')) {
        const openaiInstance = createOpenAI({
            apiKey: process.env.OPENAI_API_KEY
        })
        return openaiInstance(modelName || 'gpt-4o')
    }
    // Default fallback — Groq is free and reliable
    const groqInstance = createGroq({
        apiKey: process.env.GROQ_API_KEY
    })
    return groqInstance('llama-3.3-70b-versatile')
}

// Convert LangChain message history to Vercel AI SDK ModelMessages
function convertToCoreMessages(messages: any[]): ModelMessage[] {
    const coreMsgs: ModelMessage[] = []
    for (const msg of messages) {
        let role: 'user' | 'assistant' | 'system' | 'tool' = 'user'
        const type = typeof msg.getType === 'function' ? msg.getType() : (msg._type || msg.role)

        if (type === 'system') role = 'system'
        else if (type === 'human' || type === 'user') role = 'user'
        else if (type === 'ai' || type === 'assistant') role = 'assistant'
        else if (type === 'tool') role = 'tool'

        let content = msg.content
        if (typeof content !== 'string') {
            content = JSON.stringify(content)
        }

        if (role === 'tool') {
            coreMsgs.push({
                role: 'tool',
                content: [{
                    type: 'tool-result',
                    toolCallId: msg.tool_call_id || msg.id || 'tool-call-id',
                    toolName: msg.name || 'tool-name',
                    output: {
                        type: 'text',
                        value: content
                    }
                }]
            })
        } else if (role === 'assistant') {
            const toolCalls = msg.tool_calls?.map((tc: any) => ({
                type: 'tool-call' as const,
                toolCallId: tc.id || 'tc-id',
                toolName: tc.name,
                input: tc.args
            }))

            if (toolCalls && toolCalls.length > 0) {
                coreMsgs.push({
                    role: 'assistant',
                    content: [
                        ...(content ? [{ type: 'text' as const, text: content }] : []),
                        ...toolCalls
                    ]
                })
            } else {
                coreMsgs.push({
                    role: 'assistant',
                    content
                })
            }
        } else if (role === 'system') {
            coreMsgs.push({
                role: 'system',
                content
            })
        } else {
            coreMsgs.push({
                role: 'user',
                content
            })
        }
    }
    return coreMsgs
}

// Wrap a DB tool row into a Vercel AI SDK tool
function wrapTool(row: Tool, userId: string, toolCallCounts: Record<string, number>) {
    const shape: Record<string, any> = {}
    for (const [key, def] of Object.entries(row.inputSchema as Record<string, any>)) {
        shape[key] = def.type === 'number' ? z.number() : z.string()
        if (def.description) shape[key] = shape[key].describe(def.description)
    }

    return tool({
        description: row.description || '',
        inputSchema: z.object(shape) as any,
        execute: async (input: any) => {
            try {
                const count = (toolCallCounts[row.id] || 0) + 1
                toolCallCounts[row.id] = count

                if (count > 3) {
                    return `Tool ${row.id} has been called ${count} times. Stop calling this tool and summarize what you found so far.`
                }

                const result = await executeTool(row, input, userId)
                if (result && result.error) {
                    return `ERROR: Tool '${row.id}' failed: "${result.error}". Please inform the user of this error and do not retry.`
                }
                return typeof result === 'string' ? result : JSON.stringify(result)
            } catch (err: any) {
                logger.error({ toolId: row.id, err: err.message }, 'Tool execution error in wrapTool')
                return `ERROR: Tool '${row.id}' threw an exception: "${err.message}". Please inform the user.`
            }
        }
    })
}

export async function buildAgent(
    agentId: string,
    userId: string,
    threadId: string,
    onStep?: (step: any) => Promise<void>
) {
    // 1. Load agent config from DB
    const [agent] = await agentQueries.findById(agentId)
    if (!agent) throw new Error(`Agent ${agentId} not found`)

    const toolCallCounts: Record<string, number> = {}

    // 2. Load database tools and wrap them
    const toolRows = await getToolsForAgent(agent.toolIds)
    const toolsDict: Record<string, any> = {}

    for (const row of toolRows) {
        toolsDict[row.id] = wrapTool(row, userId, toolCallCounts)
    }

    // Load and wrap sub-agents as tools
    const subAgents = await agentQueries.findSubAgents(userId, agent.toolIds)
    for (const subAgent of subAgents) {
        const cleanName = `call_agent_${subAgent.name.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}`.slice(0, 64)
        toolsDict[cleanName] = tool({
            description: `Delegate a sub-task to the agent "${subAgent.name}". Description: "${subAgent.description || ''}". System prompt: "${subAgent.systemPrompt}"`,
            inputSchema: z.object({
                task: z.string().describe("The sub-task or instruction to delegate to this agent.")
            }) as any,
            execute: async ({ task }: { task: string }) => {
                const count = (toolCallCounts[cleanName] || 0) + 1
                toolCallCounts[cleanName] = count

                if (count > 2) {
                    throw new Error(`Sub-agent tool ${cleanName} has been called ${count} times, which exceeds the limit to prevent execution loops.`)
                }

                logger.info({ agentId, subAgentId: subAgent.id, userId, task }, 'Delegating task to sub-agent')
                try {
                    return await runAgent(subAgent.id, userId, task)
                } catch (e: any) {
                    return `ERROR: Failed to run sub-agent '${subAgent.name}': "${e.message}". DO NOT RETRY CALLING THIS SUB-AGENT.`
                }
            }
        })
    }

    logger.info(
        { agentId, toolCount: Object.keys(toolsDict).length, toolNames: Object.keys(toolsDict) },
        'Loaded all tools (including sub-agents)'
    )

    // 3. Build the system prompt
    let systemPrompt = agent.systemPrompt
    const missing = await getMissingCredentials(userId, agent.requiredCredentials)
    if (missing.length > 0) {
        const list = missing.map(m => `- ${m.label} (key: ${m.key})`).join('\n')
        systemPrompt += `\n\nREQUIRED CREDENTIALS MISSING:\n${list}\nIf the user hasn't provided these, ask for them.\nIf the user provides a secret (like a token or ID) directly in the chat, use the \`store_credential\` tool to save it immediately.`
    }

    systemPrompt += `\n\nTOOL USE RULES:
1. The ONLY valid parameter for 'perform_internet_search' is 'query' (a string).
2. The ONLY valid parameter for 'telegram_notify' is 'message' (a string).
3. NEVER include extra fields like 'id', 'cursor', or 'page' in any tool call.
4. Always provide the required parameter. Do not omit it.`

    // 4. Agent node — calls LLM with message history
    async function agentNode(state: typeof MessagesAnnotation.State) {
        const windowSize = (agent.memory as any)?.windowSize ?? 10
        const messages = state.messages.slice(-windowSize)
        const coreMessages = convertToCoreMessages(messages)

        logger.debug({ agentId, messageCount: coreMessages.length }, 'Invoking LLM')

        // Set Langfuse trace tags and name on the current span via OpenTelemetry
        const activeSpan = trace.getActiveSpan()
        if (activeSpan) {
            activeSpan.setAttribute('langfuse.trace.tags', [`agent-${agentId}`])
            activeSpan.setAttribute('langfuse.trace.name', `agent-${agentId}`)
        }

        const result = await generateText({
            model: buildVercelLLM(agent.model),
            messages: coreMessages,
            tools: toolsDict,
            stopWhen: stepCountIs(10),   // v6 API: replaces maxSteps
            system: systemPrompt,
            experimental_telemetry: {
                isEnabled: true,
                functionId: `agent-${agentId}`,
                metadata: {
                    userId,
                    sessionId: threadId,
                    agentId,
                    tags: [`agent-${agentId}`]
                }
            },
            onStepFinish: async (step: any) => {
                if (onStep) {
                    await onStep({
                        text: step.text,
                        toolCalls: step.toolCalls,
                        toolResults: step.toolResults,
                        finishReason: step.finishReason
                    })
                }
            }
        } as any)

        // Extract the final text response — result.text may be empty if the last step
        // was a tool call. Walk steps backwards to find the last non-empty text.
        let finalText = result.text || ''
        if (!finalText && result.steps && result.steps.length > 0) {
            for (let i = result.steps.length - 1; i >= 0; i--) {
                if (result.steps[i].text) {
                    finalText = result.steps[i].text
                    break
                }
            }
        }

        // If still empty after tool calls, provide a summary from tool results
        if (!finalText && result.steps && result.steps.length > 0) {
            const lastStep = result.steps[result.steps.length - 1]
            if (lastStep.toolResults && lastStep.toolResults.length > 0) {
                finalText = lastStep.toolResults
                    .map((tr: any) => typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result))
                    .join('\n')
            }
        }

        // Last resort: ask model to summarize what it did (only if we have steps)
        if (!finalText && result.steps && result.steps.length > 0) {
            finalText = `I executed ${result.steps.length} step(s) but did not produce a text response. Finish reason: ${result.finishReason}.`
        }

        logger.info({ agentId, textLength: finalText.length, steps: result.steps?.length, finishReason: result.finishReason }, 'Agent node completed')

        return {
            messages: [
                new AIMessage({
                    content: finalText
                })
            ]
        }
    }

    // 5. Build and compile the state machine (single node agent graph)
    const graph = new StateGraph(MessagesAnnotation)
        .addNode('agent', agentNode)
        .addEdge(START, 'agent')
        .addEdge('agent', END)
        .compile({ checkpointer })

    return graph
}

// Run an agent with a unique thread per call (no stale state)
export async function runAgent(
    agentId: string,
    userId: string,
    userMessage: string | undefined,
    onStep?: (step: any) => Promise<void>,
    sessionId?: string
): Promise<string> {
    logger.info({ agentId, userId, userMessage, sessionId }, 'Starting agent run')

    // Use a unique thread_id per run to avoid stale checkpoint state unless sessionId is provided
    const threadId = sessionId || `${agentId}-${userId}-${Date.now()}`
    const graph = await buildAgent(agentId, userId, threadId, onStep)

    const config = { configurable: { thread_id: threadId } }

    // For scheduled runs with no user message, inject a default prompt
    const effectiveMessage = userMessage || 'Execute your scheduled task now. Follow your system instructions.'

    // Set message history in LangGraph format
    const messages = [{ role: 'user' as const, content: effectiveMessage }]

    let lastOutput = ''
    try {
        const stream = await graph.stream({ messages }, { ...config, streamMode: 'updates', recursionLimit: 25 })

        for await (const update of stream) {
            const node = Object.keys(update)[0]
            logger.debug({ agentId, node }, `Agent step: ${node}`)

            const data = (update as any)[node]
            if (data.messages) {
                const msg = data.messages.at(-1)
                logger.debug({ agentId, msgContentType: typeof msg?.content, msgContentLength: msg?.content?.length, msgContent: msg?.content?.substring?.(0, 100) }, 'Stream message')
                if (msg && typeof msg.content === 'string' && msg.content) {
                    lastOutput = msg.content
                }
            }
        }
        logger.info({ agentId, userId, lastOutputLength: lastOutput.length }, 'Agent run completed')
    } catch (error: any) {
        logger.error({ agentId, userId, errorMessage: error?.message }, 'Error during agent stream')
        throw error
    }

    if (!lastOutput) {
        logger.warn({ agentId, userId }, 'Agent run returned empty output')
    }

    return lastOutput
}

// Run with full logging to RunLog table
export async function runAgentWithLog(
    agentId: string,
    userId: string,
    userMessage: string | undefined,
    trigger: 'chat' | 'scheduled' | 'api' | 'manual',
    sessionId?: string
): Promise<string> {
    logger.info({ agentId, userId, trigger, sessionId }, 'Running agent with DB logging')
    const [log] = await runLogQueries.create({ agentId, userId, status: 'running', runTrigger: trigger })
    const t0 = Date.now()

    try {
        const output = await runAgent(agentId, userId, userMessage, async (step) => {
            await runLogQueries.appendTrace(log.id, step)
        }, sessionId)
        await runLogQueries.updateStatus(log.id, {
            status: 'success', durationMs: Date.now() - t0,
        })
        return output
    } catch (err: any) {
        logger.error({ logId: log.id, agentId, err }, 'Agent run failed')
        await runLogQueries.updateStatus(log.id, {
            status: 'failed', durationMs: Date.now() - t0, error: err.message,
        })
        throw err
    }
}
