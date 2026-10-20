# 游戏 AI 插件合集

每个分支是一个游戏的浏览器插件（Chrome / Edge 扩展 + 油猴脚本），代码和说明都在对应分支里。

| 分支 | 游戏 | 功能 |
|---|---|---|
| [`gomoku`](https://github.com/zwandering/game-ai-plugins/tree/gomoku) | [gomoku.com](https://gomoku.com/) 五子棋 / 连珠 | AI 落子提示、胜率、自动下棋、比赛模式 |
| [`wikiracing`](https://github.com/zwandering/game-ai-plugins/tree/wikiracing) | [wikiracing.org](https://wikiracing.org/) | 提示当前页面该点哪个链接（直达 / 2 步 / 3 步）、比赛模式 |

## 获取某个插件

```bash
git clone -b gomoku https://github.com/zwandering/game-ai-plugins.git gomoku-ai-plugin
git clone -b wikiracing https://github.com/zwandering/game-ai-plugins.git wikiracing-helper
```

然后按分支里 README 的“安装”一节操作。

这个仓库原名 `gomoku-ai-plugin`，五子棋插件原来在 `main` 分支，现在移到了 `gomoku` 分支，历史完整保留。
