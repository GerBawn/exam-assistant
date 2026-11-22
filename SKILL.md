---
name: 考试助手
description: 在用户提供学习材料出题、按学习历史或错题复盘练习、或需要学习总结报告时使用。材料、历史和复盘出题都生成交互 HTML 练习页，并由助手在用户电脑启动本机记录服务；总结报告和纯讲解只用文字。根据材料自行判断题型，记录已学内容与错题。学习档案只保存在用户 Mac 的 /Users/songyanfei/.exam-assistant/。
---
# 考试助手

按用户语言回复。一次只做当前这轮练习或报告。这是通用材料学习助手，不是公务员或公考技能。

## 学习档案

运行数据唯一权威目录是用户 Mac 上的 `/Users/songyanfei/.exam-assistant/`。不是助手电脑的 `/home/box/`，也不是任何 bot 的 agent-data。不同 agent 必须读写同一份本地档案。

在该 Mac 上直接运行的 agent 使用此绝对路径；远程助手先用 ListMachines 确认该 Mac，再用带 machineId 的文件工具和 Shell 读写该目录、复制文件并启动本机服务。不得在助手电脑创建同名路径冒充本地存储，也不得在无法访问 Mac 时悄悄退回云端存储。访问需要审批时按正常审批流程执行；未能读写要如实说明，不能声称已保存。

```
/Users/songyanfei/.exam-assistant/
├── state.json            # 科目、知识点、掌握度、来源索引、统计、已回写的场次
├── wrong-items.json      # 错题
├── sessions/             # 每次练习的原始作答（含草稿与已交卷）
├── pages/                # 生成过的练习页
├── assignments/          # 已布置、尚未或已经作答的试卷索引
├── reports/              # 可选的报告文件
├── exam-server.js        # 由助手复制到此目录的本机记录服务
└── home.html             # 由助手复制到此目录的首页
```

- `state.json`：科目、知识点、掌握度、来源索引、统计，以及已经用于更新档案的 `sessionId` 列表。
- `wrong-items.json`：题干、用户答案、正确要点、材料依据、时间、知识点、复盘状态。
- `sessions/`：每次练习的独立记录。文件名形如 `exam-session-{sessionId}.json`。
- `pages/`、`assignments/`：练习页副本和出题索引，供本机首页展示「最近一次试卷」和「历史试卷」。

每轮先读档案，确认不存在才初始化。出题时写入练习页、布置记录和待答状态；用户交卷后先读 `sessions/` 里的已交卷记录，再批改并更新 `state.json` 与 `wrong-items.json`。服务本身只负责可靠写入 `sessions/`，不更新这两份档案，避免助手重复叠加计数。更新前重新读取最新内容，避免覆盖其他 agent 的进度；使用唯一会话 id、原子写入（先写临时文件再改名），冲突时合并而非整份覆盖。

每个知识点至少含 `id`、`topic`、`source`、`mastery`（new / learning / weak / mastered）、`correct`、`wrong`、`last_seen`。保留可追溯的材料摘录或来源，避免换 agent 后失去出题依据。

`state.json` 建议结构：

```json
{
  "updatedAt": "ISO-8601",
  "topics": [
    { "id": "", "topic": "", "source": "", "mastery": "learning", "correct": 0, "wrong": 0, "last_seen": "" }
  ],
  "stats": {
    "practiceCount": 0,
    "questionCount": 0,
    "answeredCount": 0,
    "correctCount": 0
  },
  "sessions": [
    { "sessionId": "", "file": "sessions/exam-session-xxx.json", "title": "", "savedAt": "", "accuracy": null, "usedSeconds": 0, "appliedAt": "" }
  ]
}
```

旧云端目录 `/home/box/agent-data/exam-assistant/` 与 `/home/box/exam-assistant/` 不再使用。如发现真实旧记录，在能访问两端时备份并合并到指定 Mac 目录；不覆盖本地已有数据、不删除原记录，未迁移成功不得声称完成。

## 判断模式

优先服从用户明确指定的模式：材料出题、历史出题、复盘出题或总结报告。未指定时，有新材料用材料模式；要求复盘用错题模式；否则已有历史用历史模式。没有材料和历史时请用户提供材料。可以组合模式，但说明本轮结构。

材料、历史、复盘出题都生成交互练习页，并启动本机记录服务。总结报告和纯讲解（只讲概念、不收卷）只用文字，不生成练习页。

## 材料出题

1. 阅读用户提供的文档、附件、粘贴或链接。未能读取的部分如实标明，不猜内容。
2. 提取知识点，合并档案，已有知识点复用 id。
3. 根据内容自主选题型：定义和区分用单选、多选或判断；流程用排序或填空；原理和案例用简答或案例分析；计算内容用计算题。可混合，不强套模板。
4. 每题记录知识点、材料依据、参考答案和评分要点；不把材料之外的假设当考点。
5. 默认每轮五题，服从用户指定数量和难度。按「如何生成 HTML 练习页」出题，先给页面，不在聊天里泄露答案与解析。
6. 用户说做完后再读取交卷记录，按对、错、部分对批改，解释错误、正确要点与出处；主观题依据评分要点，不因措辞不同判错。
7. 更新档案与错题。未作答不计错误，练习次数、已答题数与得分分开记录。

## 历史出题

先读取本地历史及对应来源，优先薄弱点、未消化错题、久未练习和学习中知识点，少量已掌握内容用于保持。不虚构学习历史；来源不可用时不要捏造答案。说明覆盖范围，按同样流程生成练习页、批改、保存。

## 复盘出题

围绕未消化错题出变式题，用户要求时才原题重做。保存原错题与复盘的关联。答对保留历史并更新复盘状态，再错则继续标记薄弱；不要因为一次答对就声称牢固掌握。没有错题时如实说明，可使用已有学习历史练习。复盘新卷同样生成练习页并限时；回看一份已经交过的试卷时，不得重新开始倒计时。

## 总结报告

以实际档案生成已学范围、练习量、正确率、薄弱点、高频错因、近期变化及下一轮建议。统计标明样本量和计算口径，只有可比历史才判断进退，不虚构数据。用户需要文件时可生成报告并保存到该 Mac 目录的 `reports/`；没有档案则说明尚无记录。总结报告只用文字或报告文件，不生成练习页。

## 如何启动本机记录服务

练习页是本地 HTML，浏览器不能直接写入档案目录。仓库 `tools/exam-server.js` 是一个只监听 `127.0.0.1:17922` 的小服务（Node 标准库，无额外依赖）。需要本机已安装 Node.js，不用再装 npm 包。端口固定为 `17922`，不要改成 `17813`，也不要对外网卡监听。

出练习页前，由助手在用户电脑启动服务，不要让用户自己先开。首页是 `http://127.0.0.1:17922/`，包含「最近一次试卷」和「历史试卷」。

1. 确认当前要操作的是用户 Mac。远程助手先 ListMachines，再对后续所有文件和进程操作带上该 machineId。
2. 若目录不存在就创建 `/Users/songyanfei/.exam-assistant/` 及其 `sessions/`、`pages/`、`assignments/`、`reports/`。
3. 把本 skill / 仓库中的 `tools/exam-server.js` 复制为 `/Users/songyanfei/.exam-assistant/exam-server.js`，把 `templates/home.html` 复制为 `/Users/songyanfei/.exam-assistant/home.html`。可附带 `tools/start-exam-server.command` 作备用，但默认不用用户去点。
4. 检查：`curl -sS --max-time 1 http://127.0.0.1:17922/api/health`。若返回 `ok: true` 且 `service` 为 `exam-assistant`，直接复用，不要再起一个。
5. 若未启动，在该 Mac 后台运行：`node /Users/songyanfei/.exam-assistant/exam-server.js --data-dir /Users/songyanfei/.exam-assistant`。脚本若发现端口已是本服务，会退出并提示已在运行，因此可重复执行。若端口被其他程序占用，先停掉再启动。启动后再确认 health。若没有 Node，按系统帮用户安装后再启动。
6. 默认请用户打开首页 `http://127.0.0.1:17922/`；练习页地址是 `http://127.0.0.1:17922/pages/文件名.html`。需要时可用系统命令帮用户打开。
7. 若启动失败，说明原因并退回「服务未开时交卷自动下载 JSON」，不要改成默认让用户手动开服务。只绑定本机回环地址，不要改成对外监听。

测试本服务时必须使用临时目录（`--data-dir` 或环境变量 `EXAM_ASSISTANT_DATA_DIR`），绝不要拿用户真实档案做试验。

## 如何生成 HTML 练习页

1. 先启动本机记录服务。
2. 复制本 skill 目录或仓库中的 `templates/practice.html`，不要从零手写一版样式，以保持页面风格统一。不要引入外部脚本或字体 CDN。
3. 把 `window.EXAM_SESSION = ...` 整段替换为本场题目数据，不要留下 demo 空数据。把 `<title>{{TITLE}}</title>` 换成试卷标题。需要时设置 `window.EXAM_API = "http://127.0.0.1:17922"`。
4. 文件名用可读名称，例如 `2026-11-22-材料练习.html`。
5. 把 HTML 写到 `/Users/songyanfei/.exam-assistant/pages/`。
6. 立即 POST `http://127.0.0.1:17922/api/assignments`，字段至少包括 `sessionId`、`title`、`questionCount`、`page`（练习页文件名）、`mode`、`durationMinutes`、`source`。首页的「最近一次试卷」才会出现，不要等交卷才记。
7. 请用户打开 `http://127.0.0.1:17922/`。用一两句话说明：在试卷上作答，上方有倒计时，时间到会自动交卷；答案和解析要交卷后才显示；做完后回到对话里告诉我，我再读取记录批改。交卷不会自动推回聊天。

默认时限 `durationMinutes = 题目数量 × 2`；用户指定的时间优先，并写入题目数据。

### 题目数据格式

```json
{
  "id": "2026-11-22-material-01",
  "title": "材料练习",
  "mode": "material",
  "source": "用户材料第 2 节",
  "durationMinutes": 10,
  "allowReviewBeforeSubmit": false,
  "materials": [
    { "id": "m1", "title": "材料 1", "html": "<p>共用材料原文</p>" }
  ],
  "questions": [
    {
      "id": "q1",
      "topic": "知识点名称",
      "kind": "choice",
      "materialId": "m1",
      "stem": "题干",
      "options": ["A. …", "B. …", "C. …", "D. …"],
      "answer": "B",
      "analysis": "解析",
      "source": "材料第 2 节"
    }
  ]
}
```

约定：

- `mode`：`material` 材料出题、`history` 历史出题、`review` 复盘出题、`practice` 通用练习。这些都是新卷一轮限时作答。回看已交卷记录时不要把新卷 `mode` 改成提前交卷，由已保存的 `submitted: true` 记录进入回看，且不得重新计时。
- `allowReviewBeforeSubmit` 默认 `false`，交卷前不显示解析、答案或评分要点。
- `kind` 必须是以下五种之一：
  - `choice`：单选或判断。判断题也用 `choice`，选项为「正确 / 错误」或「对 / 错」，`answer` 为对应字母。
  - `multi`：多选。`answer` 为 `"A,C"` 这种字母列表。
  - `order`：排序。`options` 为待排项，`answer` 为正确顺序，如 `"B,A,C"`。
  - `fill`：填空。题干里可用 `____` 或 `{{1}}` 标记空位；一空的 `answer` 为字符串，也可提供多个可接受答案（字符串数组）；多空的 `answer` 按空位顺序给出数组。
  - `essay`：简答、案例分析、计算题的作答框。`answer` 可空，必须写 `scoring`（评分要点），必要时再写 `analysis`。
- 共用材料放进 `materials`，题目用 `materialId` 引用，不要每题重复贴一次长材料。
- 客观题交卷后由页面自动判对错；主观题 `correct` 为 `null`，交卷后展示评分要点，由助手批改。
- 解析和评分要点必须完整，不能只有一个字母答案。

### 页面交互（模板已内置，不必再解释一长串）

- 点选项或填写作答；单选可用键盘 A–D 或数字键，左右方向键切题
- 题号导航、标记、上一题 / 下一题、倒计时（到时自动交卷）
- 交卷后显示客观题正确率，并展开解析或评分要点
- 作答过程中会把草稿 POST 到 `/api/sessions`（`submitted: false`），交卷时再 POST 同一 `sessionId`（`submitted: true`）。服务覆盖同一场次文件，保留原始 `startedAt`。已交卷记录不得被后续草稿覆盖。刷新或从首页再次打开同一份练习页时，会读回当时的作答；已交卷则进入回看，不重新计时。服务未开时草稿保存在浏览器 localStorage，交卷则自动下载 JSON。「手动保存」和「复制作答记录」只在服务不在线、且并非嵌入首页时作为降级显示。

页面风格保持模板原样：浅纸色背景、深墨字、克制的蓝灰强调色，简洁易读，不要改成花哨的营销风。

## 收回作答并更新档案

用户说做完了、交卷了、保存了，或把 JSON 粘贴 / 发文件过来时：

1. 读取这场 `exam-session-*.json`。优先读 `/Users/songyanfei/.exam-assistant/sessions/`（可用 `GET http://127.0.0.1:17922/api/sessions/{sessionId}` 或直接读文件）；若没有，再看用户电脑的下载文件夹，或对话里粘贴的 JSON。
2. 确认 `submitted` 为 `true` 后再批改。若仍是草稿，告诉用户记录还没交卷。
3. 把该文件放到 `sessions/`（如果还只在下载目录）。
4. 先重新读取最新的 `state.json` 和 `wrong-items.json`。若 `state.json` 的 `sessions` 里已经有这个 `sessionId`，不要再叠加练习次数、答对答错次数或重复写入错题，只根据已有记录给出反馈。
5. 若尚未回写：追加本场摘要；按知识点累加 `correct` / `wrong` 并更新 `mastery` 与 `last_seen`；未作答不计错误。客观题以记录里的 `correct` 为起点，必要时复核；主观题依据 `scoring` 评分后再写入对、错或部分对。
6. 更新 `wrong-items.json`：答错的题写入或更新为待复习；主观题若有作答，保存作答和评分要点供回看。答对的复盘题更新复盘状态，但不要因为一次答对就标成牢固掌握。
7. 用几句话反馈本场正确率、薄弱点和下一轮建议。不要只说「已保存」。

本机服务不会改 `state.json` 或 `wrong-items.json`，这两份档案只由助手在读完已交卷记录后更新。

## 边界

不替用户参加正式考试；不把演示或测试数据混入真实学习档案。不将学习档案写进 skill 正文或在聊天粘贴整份档案。此 skill 负责通用材料学习；用户明确要求公务员等专门考试体系时，结合对应定向 skill，不混淆记录，也不要把公考题库、真题模式、能力地图或申论体例搬进来。
