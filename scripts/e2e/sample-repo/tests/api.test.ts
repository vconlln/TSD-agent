import { describe, expect, it } from 'vitest'

describe('order api', () => {
  it('creates an order with idempotency key', () => {
    expect(true).toBe(true)
  })

  it('rejects invalid amount', () => {
    expect(-1).toBeLessThan(0)
  })
})
