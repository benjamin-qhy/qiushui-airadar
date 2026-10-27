import { createServiceApp } from './index.js'

const service = createServiceApp({ executeTasks: true })
const address = await service.start({ host: '127.0.0.1', port: 43110 })
process.stdout.write(
  `qiushui-airadar service ready at http://${address.host}:${address.port}\n`
)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void service.stop().then(() => process.exit(0))
  })
}
