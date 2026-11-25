import { Redis } from 'ioredis'

declare global { var __redis: Redis | undefined }

export const redis = globalThis.__redis ?? new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: null,   // required by BullMQ
    enableReadyCheck: false,  // required by BullMQ
    retryStrategy(times) {
        if (times > 2) return null // Stop retrying if Redis is not running locally
        return Math.min(times * 100, 1000)
    },
    lazyConnect: true,
})

redis.on('error', (err) => {
    // Graceful warning rather than crashing unhandled
})

if (process.env.NODE_ENV !== 'production') globalThis.__redis = redis
