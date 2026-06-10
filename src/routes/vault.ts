import type { FastifyInstance } from 'fastify'
import { setCredential, listCredentials, deleteCredential } from '../vault'
import { authHook } from '../utils/auth'

export async function vaultRoutes(fastify: FastifyInstance) {
    fastify.addHook('preHandler', authHook)

    // GET /vault — list all credentials
    fastify.get('/vault', async (req: any) => {
        return await listCredentials(req.userId)
    })

    // POST /vault — store an encrypted credential
    fastify.post('/vault', async (req: any, reply) => {
        const { key, value, label } = req.body as { key: string; value: string; label?: string }
        if (!key || !value) return reply.code(400).send({ error: 'key and value are required' })

        await setCredential(req.userId, key, value)
        return { success: true, message: `Credential ${key} stored successfully.` }
    })

    // DELETE /vault/:key — delete a credential
    fastify.delete('/vault/:key', async (req: any) => {
        const { key } = req.params as { key: string }
        await deleteCredential(req.userId, key)
        return { success: true, message: `Credential ${key} deleted.` }
    })
}
