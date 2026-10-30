import express from 'express'
import { registerOrderRoutes } from './routes/orders'
import { attachSession } from './auth'
import { getDb } from './db'

const app = express()
app.use(express.json())
app.use(attachSession)

registerOrderRoutes(app)

app.get('/health', (_req, res) => {
  res.json({ code: 0, data: { ok: true, db: Boolean(getDb()) }, message: 'ok' })
})

const port = Number(process.env.PORT ?? 3000)
app.listen(port, () => {
  console.log(`order-center listening on ${port}`)
})
