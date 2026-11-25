import './instrumentation'
import Fastify, { type FastifyError } from 'fastify'
import path from 'path'
import { fileURLToPath } from 'url'
import fastifyStatic from '@fastify/static'
import { seedTools } from './registry/seed'
import { agentRoutes } from './routes/agents'
import { toolRoutes } from './routes/tools'
import { runRoutes } from './routes/run'
import { vaultRoutes } from './routes/vault'
import { redis } from './redis'
import cors from '@fastify/cors'
import './queue'  // Start BullMQ worker for scheduled agent jobs

import { logger, loggerConfig } from './utils/logger'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const fastify = Fastify({ logger: loggerConfig })

fastify.register(cors, {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    origin: true,
})

// Serve static frontend dashboard
fastify.register(fastifyStatic, {
    root: path.join(__dirname, '../public'),
    prefix: '/',
})

fastify.register(agentRoutes, { prefix: '/api' })
fastify.register(toolRoutes, { prefix: '/api' })
fastify.register(runRoutes, { prefix: '/api' })
fastify.register(vaultRoutes, { prefix: '/api' })

fastify.setErrorHandler((error: FastifyError, request, reply) => {
    fastify.log.error(error)

    if ((error as any).code === '23505') {
        const detail = (error as any).detail
        return reply.status(409).send({
            error: 'Conflict',
            message: 'A record with this value already exists.',
            detail: detail,
        })
    }

    const statusCode = error.statusCode ?? 500
    reply.status(statusCode).send({
        error: statusCode === 500 ? 'Internal Server Error' : error.name,
        message: error.message,
    })
})

fastify.get('/health', async () => ({
    status: 'ok',
    engine: 'Orcha Agent Orchestrator',
    timestamp: new Date().toISOString()
}))

async function start() {
    try {
        await seedTools()
    } catch (err: any) {
        logger.warn({ err: err.message }, 'Database seed skipped (Database offline)')
    }

    const port = Number(process.env.PORT ?? 3001)
    await fastify.listen({
        port,
        host: '0.0.0.0',
    })
    console.log(`\n🚀 Orcha Agent Frontend & API Server running live at: http://localhost:${port}\n`)
}

// Graceful shutdown
const shutdown = async () => {
    try {
        await fastify.close()
        await redis.quit()
    } catch {}
    process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

start().catch(console.error)
