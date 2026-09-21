# policy-catalog

嵌入宿主应用的本地多租户策略目录。基于 Node.js 22.14.0 内置的 `node:sqlite`（SQLite 3.47.2，WAL 模式）实现，无第三方依赖、无网络服务、无 ORM、无迁移框架、无后台线程，也不使用跨机分布式锁。

## API

`openCatalog(filename, options)` 返回 `Catalog` 实例（也可直接 `new Catalog(...)`）。`options.now` 可注入读取时钟 `() => number`，默认 `Date.now`。

- `put(tenant, key, value, { expiresAt = null, expectedRevision }?)` → `{ revision }`：插入或覆盖一条策略。
- `remove(tenant, key, { expectedRevision }?)` → `{ revision }`：删除一条策略；删除不存在的 key 也是一次成功写入。
- `get(tenant, key, { at? }?)`：返回 `{ tenant, key, value, revision, expiresAt }`；不存在或已过期返回 `undefined`。
- `list(tenant, { prefix = '', at? }?)`：按 key 字典序（SQLite BINARY 排序）返回同形状数组，可按前缀过滤。
- `applyBatch(tenant, operations, { expectedRevision }?)` → `{ revision, revisions }`：在单个事务中按序执行多个 `{ action: 'put', key, value, expiresAt? }` / `{ action: 'remove', key }`。
- `purgeExpired({ at? }?)` → `{ count, revision }`：只删除调用时刻 `expiresAt <= at` 的行。
- `audit(tenant, { limit = 100 }?)`：按发生顺序返回该租户的审计记录 `{ revision, tenant, key, action, value, expiresAt }`。
- `revision()`：当前全局版本号。
- `close()`：关闭连接；关闭后任何方法都抛 `ClosedError`，实例不可重开。

### 输入与拷贝语义

- `tenant`、`key` 必须是非空字符串；`expiresAt` 只能是 `null` 或非负安全整数毫秒时间戳；`expectedRevision` 只能省略或为非负安全整数。
- `value` 必须可 JSON 序列化：拒绝 `undefined`、函数、`symbol`、`BigInt`、`NaN`、`±Infinity`、循环引用等。
- 值以 `JSON.stringify` 存储、`JSON.parse` 读出，输入对象与返回对象（含 `get`、`list`、`audit`）互不共享可变引用。

### TTL 读取语义

读取时刻 `at` 默认为注入/真实时钟。`expiresAt === null` 永不过期；`expiresAt > at` 可读；`expiresAt <= at` 对 `get`/`list` 不可见（边界等于即过期）。过期行仍保留在库中，直到 `purgeExpired` 物理删除。

## 事务与一致性设计

- 所有 SQL 均使用预编译语句与参数绑定，不拼接 SQL；每个写方法以 `BEGIN IMMEDIATE` 立即获取保留锁，保证两个独立连接写同一数据库时的原子提交，配合 `PRAGMA busy_timeout = 5000` 处理锁等待。
- 全局单调 revision 存于 `meta` 单行表。每次成功写入（包括同值 `put`、删除不存在的 key、batch 中的每个操作、purge 的每个实际删除）都在同一事务内把 revision 加一，并把该 revision 同时写入策略行与 audit 行；因此同批的数据与审计共享同一组连续 revision。
- `expectedRevision` 的比较发生在写事务内（拿到锁、读到最新 revision 之后）。冲突时抛 `ConflictError` 并回滚，数据、revision、audit 均无副作用。
- `applyBatch` 先在事务外做完整校验（结构、key、expiresAt、value 可序列化），任一操作非法则整批拒绝；校验通过后在一个事务内按序执行，重复 key 以最后一次生效；失败整体回滚。batch 只接受顶层 `expectedRevision`，操作内同名字段不参与比较。
- `purgeExpired` 在一个事务内选取 `expiresAt <= at` 的行，逐行分配 revision、删除并写 `action = 'purge'` 审计；无过期行时不推进 revision。

### 存储模型

```text
meta(id=1, revision)
policies(tenant, key, value_json, revision, expires_at, PRIMARY KEY(tenant, key)) WITHOUT ROWID
audit(id AUTOINCREMENT, revision, tenant, key, action, value_json, expires_at)
```

### 错误类型

均从 `src/errors.mjs` 导出，并由 `src/catalog.mjs` 再导出：

- `ValidationError`：非法输入（事务开启前抛出，无副作用）。
- `ConflictError`：revision 乐观锁冲突。
- `ClosedError`：连接已关闭。
- `StorageError`：打开、读写、关闭时的 SQLite 错误，原始错误挂在 `cause` 上。

## 运行

需要 Node.js 22.14.0（内置 `node:sqlite`，SQLite 3.47.2）。

```sh
npm test   # node --test tests/*.test.mjs，含兼容回归与全量语义测试
npm run demo  # 成功提交、冲突回滚、过期读取/purge、audit 的端到端演示
```
