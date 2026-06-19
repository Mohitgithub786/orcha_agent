import type { FastifyInstance } from 'fastify'
import { runAgentWithLog } from '../runner'
import { runLogQueries, agentQueries } from '../db/queries'
import { authHook } from '../utils/auth'

export async function runRoutes(fastify: FastifyInstance) {
    fastify.addHook('preHandler', authHook)

    // POST /run/:agentId — run agent, return response
    fastify.post('/run/:agentId', async (req: any, reply) => {
        const [agent] = await agentQueries.findById(req.params.agentId)
        if (!agent || agent.userId !== req.userId)
            return reply.code(404).send({ error: 'Agent not found' })
        const { message, sessionId } = req.body as { message?: string; sessionId?: string }

        const actualSessionId = sessionId || `session-${agent.id}-${req.userId}-${Date.now()}`
        try {
            const output = await runAgentWithLog(
                agent.id, req.userId, message, 'chat', actualSessionId
            )
            return reply.send({ output, sessionId: actualSessionId })
        } catch (err: any) {
            fastify.log.error({ agentId: agent.id, err }, 'Agent run failed in route')
            // Return a structured error so the frontend can display it clearly
            return reply.code(500).send({
                error: err.message || 'Agent execution failed',
                sessionId: actualSessionId
            })
        }
    })

    // GET /run/:agentId/logs
    fastify.get('/run/:agentId/logs', async (req: any, reply) => {
        const [agent] = await agentQueries.findById(req.params.agentId)
        if (!agent || agent.userId !== req.userId)
            return reply.code(404).send({ error: 'Not found' })

        const logs = await runLogQueries.findByAgent(agent.id)
        return reply.send(logs)
    })

    // GET /runs/:agentId — fetch traces from Langfuse API for this agent
    fastify.get('/runs/:agentId', async (req: any, reply) => {
        const [agent] = await agentQueries.findById(req.params.agentId)
        if (!agent || agent.userId !== req.userId)
            return reply.code(404).send({ error: 'Agent not found' })

        const publicKey = (process.env.LANGFUSE_PUBLIC_KEY || '').trim()
        const secretKey = (process.env.LANGFUSE_SECRET_KEY || '').trim()
        const baseUrl = process.env.LANGFUSE_BASE_URL || 'https://us.cloud.langfuse.com'

        if (!publicKey || !secretKey) {
            return reply.send([])
        }

        const { sessionId } = req.query as { sessionId?: string }

        try {
            const auth = Buffer.from(`${publicKey}:${secretKey}`).toString('base64')
            let url = `${baseUrl}/api/public/traces?userId=${req.userId}&tags=agent-${agent.id}&limit=100`
            if (sessionId) {
                url += `&sessionId=${encodeURIComponent(sessionId)}`
            }
            
            let res = await fetch(url, {
                headers: {
                    Authorization: `Basic ${auth}`
                }
            })

            if (!res.ok) {
                const text = await res.text()
                fastify.log.error(`Langfuse API error: ${res.status} ${text}`)
                return reply.code(500).send({ error: 'Failed to fetch traces from Langfuse' })
            }

            const json = await res.json() as any
            let traces = json.data || []

            // Fallback: If no traces match the direct tag query, query all user traces and filter in-memory (for older untagged traces)
            if (traces.length === 0) {
                let fallbackUrl = `${baseUrl}/api/public/traces?userId=${req.userId}&limit=100`
                if (sessionId) {
                    fallbackUrl += `&sessionId=${encodeURIComponent(sessionId)}`
                }
                const fallbackRes = await fetch(fallbackUrl, {
                    headers: {
                        Authorization: `Basic ${auth}`
                    }
                })
                if (fallbackRes.ok) {
                    const fallbackJson = await fallbackRes.json() as any
                    traces = (fallbackJson.data || []).filter((trace: any) => {
                        const metadata = trace.metadata || {}
                        const matchesAgent = metadata.agentId === agent.id || trace.name === `agent-${agent.id}` || (trace.tags && (trace.tags.includes(agent.id) || trace.tags.includes(`agent-${agent.id}`)))
                        const matchesSession = !sessionId || trace.sessionId === sessionId
                        return matchesAgent && matchesSession
                    })
                }
            } else {
                // Ensure double-safety filter for the retrieved tagged traces
                traces = traces.filter((trace: any) => {
                    const metadata = trace.metadata || {}
                    const matchesAgent = metadata.agentId === agent.id || trace.name === `agent-${agent.id}` || (trace.tags && (trace.tags.includes(agent.id) || trace.tags.includes(`agent-${agent.id}`)))
                    const matchesSession = !sessionId || trace.sessionId === sessionId
                    return matchesAgent && matchesSession
                })
            }

            // Map traces to the format expected by the frontend
            const mappedRuns = traces.map((trace: any) => {
                const hasError = trace.level === 'ERROR' || trace.metadata?.error || (trace.output && typeof trace.output === 'string' && trace.output.includes('Error'))
                
                return {
                    id: trace.id,
                    sessionId: trace.sessionId || null,
                    status: hasError ? 'failed' : 'success',
                    trigger: trace.metadata?.runTrigger || 'CHAT',
                    duration: trace.duration ? `${trace.duration.toFixed(2)}s` : '0s',
                    tokens: trace.usage?.totalTokens || 0,
                    started: new Date(trace.timestamp).toLocaleTimeString() + ' (' + new Date(trace.timestamp).toLocaleDateString() + ')'
                }
            })

            return reply.send(mappedRuns)
        } catch (e: any) {
            fastify.log.error(e, 'Failed to connect to Langfuse API')
            return reply.code(500).send({ error: 'Langfuse connection error' })
        }
    })

    // GET /runs/trace/:traceId — fetch observations for a specific trace from Langfuse API
    fastify.get('/runs/trace/:traceId', async (req: any, reply) => {
        const publicKey = (process.env.LANGFUSE_PUBLIC_KEY || '').trim()
        const secretKey = (process.env.LANGFUSE_SECRET_KEY || '').trim()
        const baseUrl = process.env.LANGFUSE_BASE_URL || 'https://us.cloud.langfuse.com'

        if (!publicKey || !secretKey) {
            return reply.send([])
        }

        try {
            const auth = Buffer.from(`${publicKey}:${secretKey}`).toString('base64')
            const url = `${baseUrl}/api/public/v2/observations?traceId=${req.params.traceId}&limit=100`
            const res = await fetch(url, {
                headers: {
                    Authorization: `Basic ${auth}`
                }
            })

            if (!res.ok) {
                const text = await res.text()
                fastify.log.error(`Langfuse API error: ${res.status} ${text}`)
                return reply.code(500).send({ error: 'Failed to fetch observations from Langfuse' })
            }

            const json = await res.json() as any
            const observations = json.data || []

            // Sort observations by startTime so they display in order
            observations.sort((a: any, b: any) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())

            // Map observations to the format expected by the frontend
            const mappedSteps = observations.map((obs: any) => {
                const type = obs.type === 'GENERATION' ? 'agent' : (obs.name && obs.name.startsWith('call_agent_') ? 'agent' : 'tool')
                const durationMs = obs.endTime && obs.startTime 
                    ? `${new Date(obs.endTime).getTime() - new Date(obs.startTime).getTime()}ms`
                    : '0ms'

                let inputStr = ''
                let outputStr = ''
                try {
                    inputStr = typeof obs.input === 'object' ? JSON.stringify(obs.input) : String(obs.input || '')
                } catch {
                    inputStr = String(obs.input || '')
                }
                try {
                    outputStr = typeof obs.output === 'object' ? JSON.stringify(obs.output) : String(obs.output || '')
                } catch {
                    outputStr = String(obs.output || '')
                }

                return {
                    id: obs.id,
                    type,
                    name: obs.name || obs.type,
                    ms: durationMs,
                    input: inputStr,
                    output: outputStr
                }
            })

            return reply.send(mappedSteps)
        } catch (e: any) {
            fastify.log.error(e, 'Failed to fetch trace details from Langfuse')
            return reply.code(500).send({ error: 'Langfuse connection error' })
        }
    })
}
