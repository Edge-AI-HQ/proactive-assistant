---
name: gws-gmail
version: 1.0.0
description: "Gmail via gws: list/search/read/send mail."
metadata:
  openclaw:
    category: "productivity"
    requires:
      bins: ["gws"]
    cliHelp: "gws gmail --help"
---

# gws gmail

> Read `../gws-shared/SKILL.md` first.

## Trigger

Use this skill when user asks:

- 最新/最近邮件
- 收件箱列表
- 搜索某个发件人或主题
- 读取某封邮件内容

If credentials exist, execute directly instead of giving setup instructions.

## Latest 10 Workflow

1. List IDs:

```bash
gws gmail users messages list --params '{"userId":"me","maxResults":10}'
```

2. Read metadata for each message:

```bash
gws gmail users messages get --params '{"userId":"me","id":"<MESSAGE_ID>","format":"full"}'
```

3. Parse headers: `From`, `Subject`, `Date`, plus `snippet`.

4. Return concise Chinese table:

- `# | 时间 | 发件人 | 主题`

## Search

```bash
gws gmail users messages list --params '{"userId":"me","q":"from:xxx@example.com newer_than:7d","maxResults":10}'
```

## Read One Message

```bash
gws gmail users messages get --params '{"userId":"me","id":"<MESSAGE_ID>","format":"full"}'
```

## Send (write operation, ask confirmation)

```bash
gws gmail +send --to '<email>' --subject '<subject>' --body '<text>'
```
