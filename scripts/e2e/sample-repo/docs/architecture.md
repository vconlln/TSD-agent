# 架构说明

```
client -> express -> routes -> sqlite
                 \-> audit table
```

## 状态机

created -> paid -> shipped -> closed
created -> cancelled
