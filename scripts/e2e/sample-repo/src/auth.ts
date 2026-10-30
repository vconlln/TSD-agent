import type { NextFunction, Request, Response } from 'express'

export interface SessionUser {
  id: string
  name: string
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: SessionUser
  }
}

export function attachSession(req: Request, _res: Response, next: NextFunction): void {
  const token = req.header('x-session')
  if (token) {
    const [id, name] = token.split(':')
    req.user = { id: id || 'anonymous', name: name || '匿名用户' }
  }
  next()
}

export function requireUser(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ code: 401, data: null, message: '未登录' })
    return
  }
  next()
}
