import 'dotenv/config'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { LangfuseSpanProcessor } from '@langfuse/otel'

if (process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY) {
    const sdk = new NodeSDK({
        spanProcessors: [new LangfuseSpanProcessor()],
    })
    sdk.start()
    console.log('📡 OpenTelemetry SDK started with Langfuse processor.')
} else {
    console.log('📡 Langfuse credentials not found. OpenTelemetry tracing is disabled.')
}
