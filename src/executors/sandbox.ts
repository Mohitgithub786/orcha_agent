import * as vm from 'node:vm'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Load vendor bundles once at startup
let lodashBundle = ''
let dayjsBundle = ''

try {
    const lodashPath = path.join(__dirname, '../../vendor/lodash.min.js')
    if (fs.existsSync(lodashPath)) {
        lodashBundle = fs.readFileSync(lodashPath, 'utf8')
    }
} catch (err) {
    console.warn('Could not load lodash bundle:', err)
}

try {
    const dayjsPath = path.join(__dirname, '../../vendor/dayjs.min.js')
    if (fs.existsSync(dayjsPath)) {
        dayjsBundle = fs.readFileSync(dayjsPath, 'utf8')
    }
} catch (err) {
    console.warn('Could not load dayjs bundle:', err)
}

export async function runInSandbox(code: string, input: any): Promise<any> {
    const sandbox: Record<string, any> = {
        __input: input,
        console: { ...console },
        JSON,
        Math,
        Date,
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
    }

    const context = vm.createContext(sandbox)

    if (lodashBundle) {
        vm.runInContext(lodashBundle, context)
    }
    if (dayjsBundle) {
        vm.runInContext(dayjsBundle, context)
    }

    const script = `
      ${code}
      JSON.stringify(run(__input))
    `
    const result = vm.runInContext(script, context, { timeout: 5000 })
    return JSON.parse(result as string)
}
