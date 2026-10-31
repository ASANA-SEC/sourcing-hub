# Sourcing Hub — Supplier Register 和 RFQ Sourcing

独立平台，自己的网址、后端、Google Sheet 和用户名单。RFQ Hub 只被读取，不会被修改。

- 网址：<https://asana-sec.github.io/sourcing-hub/>
- **Super admin（3 位）**：`sam.secov@gmail.com`、`szesian.mitosc@gmail.com`、`eileen.secov@gmail.com`（写在 `assets/core.js` 的 SUPER_ADMINS）
- 后端部署账号：`proc.sec1@gmail.com`（RFQ 邮件会从这个账号发出）
- Google 登录的 Client ID 沿用 Project Hub

> 这个仓库是公开的。CC 邮箱、邮件签名、供应商资料和真实 RFQ 内容都不要写进代码。

## 功能

- **Supplier Register**：供应商名单，包括邮箱、类型、国家、评级和有效期
- **RFQ Sourcing**：
  1. 从 RFQ Hub 选 Section 和栏（默认 Pending），按 **Import** 存一份副本
  2. 填邮件标题和交货地点，增删供应商，也可以从 Supplier Register 加（Inactive、Blacklisted 不会列出）
  3. 按 **Approve final list** 批准。批准后再保存修改，名单会退回草稿
  4. **Refresh from RFQ Hub** 重新读取任务内容，供应商名单和批准状态不变

- **RFQ 邮件**（任务页下方）：
  1. **Send test to me** 只发给按按钮的人，没有 CC，标题加 `[TEST]`
  2. **Create drafts** 先重新读取 RFQ Hub 的任务和附件，再在发信账号的 Gmail 为每个供应商建一封草稿
  3. **Approve and send** 要按两次，一封一封发，出错就停，不会重复发
  4. 名单、任务内容或邮件设定改过之后，旧草稿不能发，要重新建
  5. 附件只在 Asana 的任务默认不能建草稿，要先上传到 RFQ Hub，或者勾选不带这些文件
- **回复监控**：后端每 10 分钟读一次已发出的邮件线。退信、带文档的回复（标成 Possible quotation）和其他回复（标成 Reply: decide）都会马上发邮件通知，系统不会自己回复。自动回复只记录，不通知
- **自动跟进**（默认关闭，在 Email settings 打开）：每天 9am 一封，截止当天 1pm 再加一封最后提醒；只发给没有回复的供应商，发信当天和截止后都不发；额度少于 10 会停下并通知
- **Email settings**（Super admin）：发信账号、CC 和签名，存在私有的 Google Sheet，不进公开仓库

**Gmail 限制：** Google 对普通 Gmail 账号的脚本发信限制是每天 100 个收件人，CC 可能也计入。页面会显示当天剩余额度；超过时 Google 会拒发，系统会停下并显示错误。

**权限跟 Supplier Register 走：** Viewer 只能看，Editor 可以修改，Manager 和 Super admin 可以批准。要读取 RFQ Hub，使用者也要有 RFQ Hub 的账号和权限。

## 上线步骤（Sam 做，约 5 分钟）

1. 用 **proc.sec1@gmail.com** 打开 <https://script.google.com/> → **New project**，项目名改成 `Sourcing Hub API`
2. 把 `apps-script/Code.gs` 的全部内容贴进 `Code.gs`
3. 左侧 Files 旁边按 **+ → Script**，命名为 `Core`，把 `assets/core.js` 的全部内容贴进去
4. ⚙️ **Project Settings** → Time zone 选 `(GMT+08:00) Kuala Lumpur`
5. 回到 `Code.gs`，函数选单选 **setup** → **Run** → 授权（未验证的应用 → Advanced → Go to Sourcing Hub API）
6. **Deploy → New deployment** → Web app，Execute as **Me**，Who has access **Anyone** → 复制 **Web app URL**（结尾 `/exec`）交给小助
7. 小助填进 `config.js`（同时把 index.html 的 `config.js?v=` 加 1）推上线
8. 用 sam.secov@gmail.com 登录网址 → **Create the standard sections** → Users & access 加同事

> 以后 Code.gs 或 core.js 有更新，两个文件都要重新贴，再 **Deploy → Manage deployments → ✏️ → New version**，网址不变。
> Google Sheet 的分页保持普通范围，**不要**转成 Table。

## 本机测试

打开 `http://localhost:8770/?demo`（launch.json 名称 `sourcing-hub`）。演示模式的 RFQ Hub 任务是假资料，不会连到真正的 RFQ Hub。

示例账号：Siti（Manager，可批准）、Mei Ling（Viewer）、Raj（没有权限）。

## 文件结构

| 文件 | 用途 |
|---|---|
| `index.html` | 网页入口 |
| `config.js` | 设定（API 网址、RFQ Hub API 网址、Client ID） |
| `assets/core.js` | 权限与数据规则：网页和后端共用（后端贴成 Core.gs） |
| `assets/templates.js` | Supplier Register 模板 |
| `assets/app.js` | 全部画面和操作 |
| `assets/api.js` | 数据层（演示模式示例数据 / Google 后端 / 只读 RFQ Hub） |
| `assets/archive.js` | 封存 / 备份 / 还原 |
| `assets/style.css` | 样式 |
| `apps-script/Code.gs` | Google 后端 |
