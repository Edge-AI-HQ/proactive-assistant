# APIs 开发约束

继承项目根 AGENTS.md 所有规则。

## TypeScript
- 严格模式，禁止 `any` 和 `@ts-ignore`。import 带 `.js` 扩展名（ESM）。
- catch 变量是 `unknown`，必须类型守卫后使用。

## 错误处理
- 业务错误抛 `DomainError(code, message)`，不抛原生 Error。
- 错误码：`INVALID_INPUT` / `NOT_FOUND` / `CONFLICT` / `UNAUTHORIZED` / `UNAVAILABLE` / `INTERNAL`。
- controller 用 `isDomainError()` 捕获并映射 HTTP status。

## 分层
- **controller/**：HTTP 解析和响应，不放业务逻辑。
- **domain/**：业务逻辑和数据访问，跨 domain 显式 import。
- **domain/common/**：共享基础设施（config、db、errors、logging）。
- 路由工厂模式：`createXRouter()` + `registerXRoutes(app)`。

## 数据库
- query 通过 `Queryable` 类型，支持事务传递。schema 变更走 migration。

## 命名
- 文件 snake_case，类/接口 PascalCase，函数/变量 camelCase，常量 UPPER_SNAKE_CASE。
