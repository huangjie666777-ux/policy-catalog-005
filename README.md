# policy-catalog

这是一个嵌入宿主应用的本地多租户策略目录。初始实现使用 Node.js 22 的 `node:sqlite`，没有网络服务或第三方依赖。

## API

`openCatalog(filename, options)` 返回 `Catalog`。公开方法为 `put`、`remove`、`get`、`list`、`applyBatch`、`purgeExpired`、`audit`、`revision` 和 `close`。租户和 key 组成主键；值存储为 JSON；每次写入会增加全局 revision 并写入审计。

## 运行

```sh
npm test
npm run demo
```

本文件描述的是目标行为和现有骨架边界；实现仍需按任务提示修复。
