import type { FastifyInstance } from 'fastify'
import { createGroq } from '@ai-sdk/groq'
import { generateText } from 'ai'
import { agentQueries } from '../db/queries'
import { scheduleAgent, pauseAgent } from '../queue'
import { getMissingCredentials } from '../vault'
import { authHook } from '../utils/auth'

let model: any = null

// Meta-prompt: generates a valid AgentConfig JSON from a user description
async function generateAgentConfig(prompt: string, userId?: string, sessionId?: string) {
    if (!model) {
        const groqInstance = createGroq({
            apiKey: process.env.GROQ_API_KEY
        })
        model = groqInstance('llama-3.3-70b-versatile')
    }
    const response = await generateText({
        model,
        messages: [
            {
                role: 'system',
                content: `You are an AI agent configuration generator.
Given a description, return ONLY valid JSON — no markdown, no explanation, no code fences.

The JSON must match this exact shape:
{
  "name": string,
  "description": string,
  "model": "gemini-3-flash-preview",
  "systemPrompt": string,
  "type": "chat" or "scheduled",
  "interval": string or null,
  "toolIds": string[],
  "memory": { "windowSize": number, "persistPerUser": boolean },
  "requiredCredentials": [{ "key": string, "label": string, "url": string }]
}

Available tool IDs: ["perform_internet_search", "telegram_notify", "send_email", "store_credential"]
Pick tools that match the user's intent.
For scheduled agents set type="scheduled" and a sensible interval.
For credentials, use these EXACT keys:
- telegram_notify: ["TELEGRAM_TOKEN", "TELEGRAM_CHAT_ID"]
- send_email: ["SMTP_USER", "SMTP_PASS", "SMTP_HOST"]
Only include credentials for chosen tools.`
            },
            {
                role: 'user',
                content: `User description: "${prompt}"`
            }
        ],
        experimental_telemetry: {
            isEnabled: true,
            metadata: {
                userId: userId ?? '',
                sessionId: sessionId ?? ''
            }
        }
    })

    return JSON.parse(response.text)
}

// AI prompt improvement helper
async function improveSystemPrompt(prompt: string, userId?: string, sessionId?: string): Promise<string> {
    if (!model) {
        const groqInstance = createGroq({
            apiKey: process.env.GROQ_API_KEY
        })
        model = groqInstance('llama-3.3-70b-versatile')
    }
    const response = await generateText({
        model,
        messages: [
            {
                role: 'system',
                content: `You are an expert prompt engineer. Your job is to optimize, refine, and improve the system prompt for an AI agent to make it more precise, structured, clear, and effective. Correct any logical errors, improve readability, and keep it clean. Do not include markdown code blocks or explanations in your response, return ONLY the raw improved system prompt content.`
            },
            {
                role: 'user',
                content: `Here is the current system prompt to improve:\n\n"${prompt}"`
            }
        ],
        experimental_telemetry: {
            isEnabled: true,
            metadata: {
                userId: userId ?? '',
                sessionId: sessionId ?? ''
            }
        }
    })
    return response.text
}

// AI prompt generation helper
async function generateSystemPrompt(description: string, userId?: string, sessionId?: string): Promise<string> {
    if (!model) {
        const groqInstance = createGroq({
            apiKey: process.env.GROQ_API_KEY
        })
        model = groqInstance('llama-3.3-70b-versatile')
    }
    const response = await generateText({
        model,
        messages: [
            {
                role: 'system',
                content: `You are an expert prompt engineer. Your job is to generate a comprehensive, professional system prompt for an AI agent based on a user's description. The system prompt should outline the agent's role, objectives, behavior guidelines, and tone. Do not include markdown code blocks or explanations in your response, return ONLY the raw generated system prompt content.`
            },
            {
                role: 'user',
                content: `Here is the description of what the agent should do:\n\n"${description}"`
            }
        ],
        experimental_telemetry: {
            isEnabled: true,
            metadata: {
                userId: userId ?? '',
                sessionId: sessionId ?? ''
            }
        }
    })
    return response.text
}

export async function agentRoutes(fastify: FastifyInstance) {
    fastify.addHook('preHandler', authHook)

    // POST /agents — generate config from prompt, create agent
    fastify.post('/agents', async (req: any, reply) => {
        const { prompt } = req.body as { prompt: string }
        if (!prompt) return reply.code(400).send({ error: 'prompt is required' })

        fastify.log.info({ prompt }, 'Generating agent config from prompt')
        let config
        try {
            const sessionToken = req.headers['x-session-token'] || req.headers['authorization'] || 'agents-session'
            config = await generateAgentConfig(prompt, req.userId, sessionToken)
            fastify.log.info({ config }, 'Generated agent config')
        } catch (error) {
            fastify.log.error(error, 'Failed to generate agent config')
            return reply.code(500).send({ error: 'Failed to generate agent configuration' })
        }
        try {
            const [agent] = await agentQueries.create({ ...config, userId: req.userId })
            fastify.log.info({ agentId: agent.id }, 'Created agent')

            // Check which credentials the user is missing
            const missing = await getMissingCredentials(req.userId, agent.requiredCredentials)
            return reply.send({ agent, missingCredentials: missing })
        } catch (error) {
            fastify.log.error({ error, config }, 'Failed to create agent in database')
            throw error // Rethrow to let global error handler handle it
        }
    })

    // POST /agents/improve-prompt — improve prompt using AI
    fastify.post('/agents/improve-prompt', async (req: any, reply) => {
        const { prompt } = req.body as { prompt: string }
        if (!prompt) return reply.code(400).send({ error: 'prompt is required' })

        try {
            const sessionToken = req.headers['x-session-token'] || req.headers['authorization'] || 'improve-session'
            const improved = await improveSystemPrompt(prompt, req.userId, sessionToken)
            return reply.send({ prompt: improved })
        } catch (error) {
            fastify.log.error(error, 'Failed to improve system prompt')
            return reply.code(500).send({ error: 'Failed to improve system prompt' })
        }
    })

    // POST /agents/generate-prompt — generate system prompt using AI
    fastify.post('/agents/generate-prompt', async (req: any, reply) => {
        const { description } = req.body as { description: string }
        if (!description) return reply.code(400).send({ error: 'description is required' })

        try {
            const sessionToken = req.headers['x-session-token'] || req.headers['authorization'] || 'generate-session'
            const generated = await generateSystemPrompt(description, req.userId, sessionToken)
            return reply.send({ prompt: generated })
        } catch (error) {
            fastify.log.error(error, 'Failed to generate system prompt')
            return reply.code(500).send({ error: 'Failed to generate system prompt' })
        }
    })

    // GET /agents
    fastify.get('/agents', async (req: any) => {
        return agentQueries.findByUser(req.userId)
    })

    // GET /agents/:id
    fastify.get('/agents/:id', async (req: any, reply) => {
        const [agent] = await agentQueries.findById(req.params.id)
        if (!agent || agent.userId !== req.userId) return reply.code(404).send({ error: 'Not found' })
        return agent
    })

    // PATCH /agents/:id
    fastify.patch('/agents/:id', async (req: any, reply) => {
        const [existing] = await agentQueries.findById(req.params.id)
        if (!existing || existing.userId !== req.userId) return reply.code(404).send({ error: 'Not found' })

        try {
            const body = req.body as any
            fastify.log.info({ agentId: req.params.id, body }, 'PATCH agent')
            const [updated] = await agentQueries.update(req.params.id, body)
            return updated
        } catch (error: any) {
            fastify.log.error({ error: error.message, body: req.body }, 'PATCH agent failed')
            return reply.code(500).send({ error: error.message })
        }
    })

    // POST /agents/:id/publish
    fastify.post('/agents/:id/publish', async (req: any, reply) => {
        const [existing] = await agentQueries.findById(req.params.id)
        if (!existing || existing.userId !== req.userId) return reply.code(404).send({ error: 'Not found' })

        const [published] = await agentQueries.publish(req.params.id)

        // Re-read from DB to get the latest interval (may have been updated just before publish)
        const [agent] = await agentQueries.findById(req.params.id)

        if (agent.type === 'scheduled' && agent.interval) {
            fastify.log.info({ agentId: agent.id, interval: agent.interval }, 'Scheduling agent on publish')
            await scheduleAgent(agent.id, req.userId, agent.interval)
        }
        return published
    })

    // POST /agents/:id/pause
    fastify.post('/agents/:id/pause', async (req: any, reply) => {
        const [agent] = await agentQueries.findById(req.params.id)
        if (!agent || agent.userId !== req.userId) return reply.code(404).send({ error: 'Not found' })
        await pauseAgent(agent.id)
        const [paused] = await agentQueries.pause(req.params.id)
        return paused
    })
}
