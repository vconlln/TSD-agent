import type { Express, Request, Response } from 'express'
import { randomUUID } from 'node:crypto'
import { getDb } from '../db'
import { requireUser } from '../auth'

const ORDER_STATUS = ['created', 'paid', 'shipped', 'closed', 'cancelled'] as const

function now(): string {
  return new Date().toISOString()
}

export function registerOrderRoutes(app: Express): void {
  app.post('/api/orders', requireUser, (req: Request, res: Response) => {
    const { amount, requestId } = req.body ?? {}
    if (typeof amount !== 'number' || amount <= 0) {
      res.status(400).json({ code: 400, data: null, message: '金额不合法' })
      return
    }
    const db = getDb()
    const existing = requestId
      ? db.prepare('SELECT id FROM orders WHERE id = ?').get(String(requestId))
      : undefined
    if (existing) {
      res.json({ code: 0, data: existing, message: '幂等返回' })
      return
    }
    const id = requestId ? String(requestId) : randomUUID()
    db.prepare('INSERT INTO orders (id, user_id, amount, status, created_at) VALUES (?, ?, ?, ?, ?)').run(
      id,
      req.user!.id,
      amount,
      'created',
      now(),
    )
    db.prepare('INSERT INTO audits (action, payload, created_at) VALUES (?, ?, ?)').run(
      'order.create',
      JSON.stringify({ id, amount }),
      now(),
    )
    res.status(201).json({ code: 0, data: { id, status: 'created' }, message: 'ok' })
  })

  app.get('/api/orders/:id', requireUser, (req: Request, res: Response) => {
    const row = getDb().prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id)
    if (!row) {
      res.status(404).json({ code: 404, data: null, message: '订单不存在' })
      return
    }
    res.json({ code: 0, data: row, message: 'ok' })
  })

  app.post('/api/orders/:id/transition', requireUser, (req: Request, res: Response) => {
    const { status } = req.body ?? {}
    if (!ORDER_STATUS.includes(status)) {
      res.status(400).json({ code: 400, data: null, message: '非法状态' })
      return
    }
    getDb().prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, req.params.id)
    res.json({ code: 0, data: { id: req.params.id, status }, message: 'ok' })
  })
}
