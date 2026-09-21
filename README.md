# policy-catalog

这是一个嵌入宿主应用的本地多租户策略目录。实现使用 Node.js 22.14.0 内置的
`node:sqlite`（SQLite 3.47.2），没有网络服务、ORM、迁移框架、后台线程或第三方依赖。

## API

`openCatalog(filename, options)` 返回 `Catalog`。公开方法为 `put`、`remove`、`get`、
`list`、`applyBatch`、`purgeExpired`、`audit`、`revision` 和 `close`。
`options.now` 可注入读取时钟（默认 `Date.now`），便于测试 TTL 边界。

## 设计说明

- **数据模型**：`policies(tenant, key, value_json, revision, expires_at)` 以
  `(tenant, key)` 为主键；`meta` 单行保存全局 `revision`；`audit` 追加式记录每次写入。
- **校验**：`tenant`/`key` 必须是非空字符串；`value` 必须可 JSON 序列化
  （拒绝 `undefined`、函数、Symbol、BigInt、`NaN`/`Infinity` 及循环引用）；
  `expiresAt` 只能为 `null` 或非负整数毫秒。校验失败抛 `ValidationError`，
  发生在任何写库之前，因此不消耗 revision。
- **读取语义**：`get`/`list` 按读取时钟过滤 `expiresAt <= now`（边界即过期）；
  `list` 按 key 字典序返回。所有返回值经 JSON 深拷贝，输入输出不共享可变引用。
- **事务与 revision**：所有写操作（`put`/`remove`/`applyBatch`/`purgeExpired`）
  在 `BEGIN IMMEDIATE` 事务中执行，全部使用参数绑定。每次成功写入——包括同值
  `put`、删除不存在的键、非空 batch——分配一个全局单调递增的 revision，同一
  batch 的数据行与 audit 行共享该 revision。batch 先完整校验全部操作，再在单个
  事务中按序执行；任一失败整体回滚数据、revision 和 audit。
- **乐观并发**：`expectedRevision` 在事务内与 `meta` 比较，不符抛
  `ConflictError` 且无任何副作用。多个连接写同一数据库文件时
  `BEGIN IMMEDIATE` 保证原子提交；`SQLITE_BUSY` 等底层错误包装为带
  `cause` 的 `StorageError`。
- **TTL 清理**：`purgeExpired` 只删除调用时刻已过期的行，为实际删除的行写
  `purge` audit；没有可删行时不分配 revision。
- **生命周期**：`close()` 之后所有方法抛 `ClosedError`，实例不可重开。

## 运行

```sh
npm test        # node --test tests/*.test.mjs
npm run demo    # 成功提交、冲突回滚、过期读取与 audit 演示
```
