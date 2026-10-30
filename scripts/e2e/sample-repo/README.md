# 订单中心

订单创建、状态流转与支付回调服务。

## 快速开始

```bash
npm install
npm run dev
```

## 目录结构

```
src/
  server.ts       入口
  auth.ts         会话认证
  routes/         HTTP 路由
  db.ts           SQLite 连接
tests/
  api.test.ts     接口测试
```

## 约定

- 所有接口返回 `{ code, data, message }`
- 写操作必须写入审计表
