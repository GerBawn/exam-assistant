---
name: 考试助手
description: 在用户提供学习材料出题、按学习历史或错题复盘练习、或需要学习总结报告时使用。材料、历史和复盘出题都生成交互 HTML 练习页，并由助手在用户电脑启动本机记录服务；总结报告和纯讲解只用文字。根据材料自行判断题型，记录已学内容与错题。学习档案保存在用户 Mac 的 /Users/songyanfei/.exam-assistant/。
---
# 考试助手

按用户语言回复。一次完成当前这轮练习或报告。这是通用材料学习助手。用户要公务员考试体系时，使用对应的定向 skill，两套档案分开保存。此 skill 用于学习练习，正式考试由用户本人完成。

## 学习档案

学习档案在用户 Mac 的 `/Users/songyanfei/.exam-assistant/`。在该 Mac 上直接运行的 agent 使用此绝对路径；远程助手先用 ListMachines 确认该 Mac，再用带 machineId 的文件工具和 Shell 读写该目录、复制文件并启动本机服务。访问需要审批时按正常审批流程执行。本轮该路径无法写入时，说明受阻原因，并告知档案保持原样。

```
/Users/songyanfei/.exam-assistant/
├── state.json            # 科目、知识点、掌握度、来源索引、统计、已回写的场次
├── wrong-items.json      # 错题
├── sessions/             # 每次练习的原始作答（含草稿与已交卷）
├── pages/                # 生成过的练习页
├── assignments/          # 已布置的试卷索引
├── reports/              # 可选的报告文件
├── exam-server.js        # 由助手复制到此目录的本机记录服务
└── home.html             # 由助手复制到此目录的首页
```

- `state.json`：科目、知识点、掌握度、来源索引、统计，以及已经用于更新档案的 `sessionId` 列表。
- `wrong-items.json`：题干、用户答案、正确要点、材料依据、时间、知识点、复盘状态。
- `sessions/`：每次练习的独立记录，文件名形如 `exam-session-{sessionId}.json`。
- `pages/`、`assignments/`：练习页副本和出题索引，供本机首页展示「最近一次试卷」和「历史试卷」。

每轮先读档案；目录或文件尚不存在时再初始化。出题时写入练习页、布置记录和待答状态。本机服务把作答写入 `sessions/`；交卷后由助手按「收回作答并更新档案」更新 `state.json` 与 `wrong-items.json`。更新前重新读取最新内容；使用唯一会话 id、原子写入（先写临时文件再改名）；冲突时合并两边的进度。

每个知识点至少含 `id`、`topic`、`source`、`mastery`（new / learning / weak / mastered）、`correct`、`wrong`、`last_seen`，并保留可追溯的材料摘录或来源。

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

若发现更早的练习记录且两端都可读，合并到 `/Users/songyanfei/.exam-assistant/`：保留该目录里已有文件，保留原记录；本目录已持有合并后的全部记录时，迁移才算完成。

演示和测试写入临时目录，路径由 `--data-dir` 或 `EXAM_ASSISTANT_DATA_DIR` 指定。档案留在上述目录；对话里反馈本场摘要和建议。

## 判断模式

优先服从用户明确指定的模式：材料出题、历史出题、复盘出题或总结报告。未指定时，有新材料用材料模式；要求复盘用错题模式；否则已有历史用历史模式。没有材料和历史时请用户提供材料。可以组合模式，并说明本轮结构。

材料、历史、复盘出题都生成交互练习页，并启动本机记录服务。总结报告和纯讲解（只讲概念）使用文字。

## 材料出题

1. 阅读用户提供的文档、附件、粘贴或链接；未能读取的部分如实标明，只依据已读到的内容出题。
2. 提取知识点，与档案合并，已有知识点复用 id。
3. 根据内容选题型：定义和区分用单选、多选或判断；流程用排序或填空；原理和案例用简答或案例分析；计算内容用计算题。可混合出题。
4. 每题记录知识点、材料依据、参考答案和评分要点；考点只来自材料。
5. 默认每轮五题，服从用户指定数量和难度。按「如何生成 HTML 练习页」出题，先把练习页交给用户；答案和解析在交卷后出现在页面上。
6. 用户说做完后，按「收回作答并更新档案」批改并更新档案。

## 历史出题

先读取本地历史及对应来源，优先薄弱点、未消化错题、久未练习和学习中知识点，少量已掌握内容用于保持。依据档案中的学习历史和对应来源出题，并说明覆盖范围。来源仍可读时，答案与解析以该来源为准；来源不可用时，使用档案里已有的要点，并标明依据。随后按同样流程生成练习页，并在用户做完后收回作答。

## 复盘出题

围绕未消化错题出变式题；用户要求时才原题重做，并保存原错题与复盘的关联。没有错题时如实说明，可改用已有学习历史练习。复盘新卷同样生成练习页并限时。回看已交卷的试卷时，根据已保存的 `submitted: true` 记录进入回看。

## 总结报告

以实际档案生成已学范围、练习量、正确率、薄弱点、高频错因、近期变化及下一轮建议。统计标明样本量和计算口径；只有可比历史才判断进退。用户需要文件时，把报告保存到该 Mac 目录的 `reports/`；尚无档案时说明尚无记录。总结报告使用文字或报告文件。

## 如何启动本机记录服务

练习页是本地 HTML，浏览器通过本机服务写入档案目录。仓库 `tools/exam-server.js` 是一个绑定 `127.0.0.1:17922` 的小服务（Node 标准库，无额外依赖）。需要本机已安装 Node.js。

出练习页前，由助手在用户电脑启动服务。首页是 `http://127.0.0.1:17922/`，包含「最近一次试卷」和「历史试卷」。

1. 确认当前要操作的是用户 Mac。远程助手先 ListMachines，再对后续所有文件和进程操作带上该 machineId。
2. 若目录不存在，创建 `/Users/songyanfei/.exam-assistant/` 及其 `sessions/`、`pages/`、`assignments/`、`reports/`。
3. 把本 skill / 仓库中的 `tools/exam-server.js` 复制为 `/Users/songyanfei/.exam-assistant/exam-server.js`，把 `templates/home.html` 复制为 `/Users/songyanfei/.exam-assistant/home.html`。可附带 `tools/start-exam-server.command` 作备用。
4. 检查：`curl -sS --max-time 1 http://127.0.0.1:17922/api/health`。若返回 `ok: true` 且 `service` 为 `exam-assistant`，复用该进程。
5. 若尚未启动，在该 Mac 后台运行：`node /Users/songyanfei/.exam-assistant/exam-server.js --data-dir /Users/songyanfei/.exam-assistant`。脚本若发现端口已是本服务，会退出并提示已在运行，因此可重复执行。若端口被其他程序占用，先停掉再启动。启动后再确认 health。若没有 Node，按系统帮用户安装后再启动。
6. 请用户打开首页 `http://127.0.0.1:17922/`；练习页地址是 `http://127.0.0.1:17922/pages/文件名.html`。需要时可用系统命令帮用户打开。
7. 若启动失败，说明原因，并使用「服务未开时交卷自动下载 JSON」。

测试本服务时，使用 `--data-dir` 或环境变量 `EXAM_ASSISTANT_DATA_DIR`，指向临时目录。

## 如何生成 HTML 练习页

1. 先启动本机记录服务。
2. 复制本 skill 目录或仓库中的 `templates/practice.html`，沿用模板内的样式和脚本。
3. 把 `window.EXAM_SESSION = ...` 整段替换为本场题目数据，把 `<title>{{TITLE}}</title>` 换成试卷标题。需要时设置 `window.EXAM_API = "http://127.0.0.1:17922"`。
4. 文件名用可读名称，例如 `2026-11-22-材料练习.html`。
5. 把 HTML 写到 `/Users/songyanfei/.exam-assistant/pages/`。
6. 立即 POST `http://127.0.0.1:17922/api/assignments`，字段至少包括 `sessionId`、`title`、`questionCount`、`page`（练习页文件名）、`mode`、`durationMinutes`、`source`，首页的「最近一次试卷」随即出现。
7. 请用户打开 `http://127.0.0.1:17922/`。用一两句话说明：在试卷上作答，上方有倒计时，时间到会自动交卷；答案和解析在交卷后显示在页面上；做完后回到对话里告诉我，我再读取记录批改。交卷记录先落在本机。

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

- `mode`：`material` 材料出题、`history` 历史出题、`review` 复盘出题、`practice` 通用练习。这些都是新卷一轮限时作答。回看已交卷记录时，根据已保存的 `submitted: true` 记录进入回看。
- `allowReviewBeforeSubmit` 默认 `false`，答案、解析和评分要点在交卷后显示。
- `kind` 必须是以下五种之一：
  - `choice`：单选或判断。判断题也用 `choice`，选项为「正确 / 错误」或「对 / 错」，`answer` 为对应字母。
  - `multi`：多选。`answer` 为 `"A,C"` 这种字母列表。
  - `order`：排序。`options` 为待排项，`answer` 为正确顺序，如 `"B,A,C"`。
  - `fill`：填空。题干里可用 `____` 或 `{{1}}` 标记空位；一空的 `answer` 为字符串，也可提供多个可接受答案（字符串数组）；多空的 `answer` 按空位顺序给出数组。
  - `essay`：简答、案例分析、计算题的作答框。`answer` 可空，必须写 `scoring`（评分要点），必要时再写 `analysis`。
- 共用材料放进 `materials`，题目用 `materialId` 引用。
- 客观题交卷后由页面自动判对错；主观题 `correct` 为 `null`，交卷后展示评分要点，由助手批改。
- 每题写完整的解析；主观题必须写 `scoring`。

### 页面交互

模板已内置以下能力，沿用即可：

- 点选项或填写作答；单选可用键盘 A–D 或数字键，左右方向键切题
- 题号导航、标记、上一题 / 下一题、倒计时（到时自动交卷）
- 交卷后显示客观题正确率，并展开解析或评分要点
- 作答过程中会把草稿 POST 到 `/api/sessions`（`submitted: false`），交卷时再 POST 同一 `sessionId`（`submitted: true`）。服务覆盖同一场次文件，保留原始 `startedAt`。仅在该场仍为未交卷时写入草稿；已交卷记录保持为最终作答。刷新或从首页再次打开同一份练习页时，会读回当时的作答；已交卷则进入回看，沿用当时用时。服务未开时草稿保存在浏览器 localStorage，交卷则自动下载 JSON。服务不在线且页面为独立打开时，显示「手动保存」和「复制作答记录」。

页面沿用模板风格：浅纸色背景、深墨字、克制的蓝灰强调色，简洁易读。

## 收回作答并更新档案

用户说做完了、交卷了、保存了，或把 JSON 粘贴 / 发文件过来时：

1. 读取这场 `exam-session-*.json`。先读 `/Users/songyanfei/.exam-assistant/sessions/`（可用 `GET http://127.0.0.1:17922/api/sessions/{sessionId}` 或直接读文件）；若没有，再看用户电脑的下载文件夹，或对话里粘贴的 JSON。
2. 确认 `submitted` 为 `true` 后再批改。若仍是草稿，告诉用户记录还没交卷。
3. 若该文件还在下载目录，把它放到 `sessions/`。
4. 先重新读取最新的 `state.json` 和 `wrong-items.json`。若 `state.json` 的 `sessions` 里已经有这个 `sessionId`，根据已有记录给出反馈，保持现有计数和错题列表。
5. 若尚未回写：追加本场摘要；按知识点累加 `correct` / `wrong` 并更新 `mastery` 与 `last_seen`。错误次数只计入已作答且答错的题。客观题以记录里的 `correct` 为起点，必要时复核；主观题依据 `scoring` 评分后再写入对、错或部分对，意思对即可。
6. 更新 `wrong-items.json`：答错的题写入或更新为待复习；主观题若有作答，保存作答和评分要点供回看。答对的复盘题更新复盘状态和计数；升到 `mastered` 以累计表现为准。
7. 用几句话反馈本场正确率、薄弱点和下一轮建议。

`state.json` 与 `wrong-items.json` 由助手在读完已交卷记录后更新。
